import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ReviewReceipt } from '../gate-runtime/review-context';
import {
    computeProtectedSnapshotDigest,
    normalizePath,
    joinOrchestratorPath,
    resolvePathInsideRepo,
    toPlainRecord,
    getProtectedControlPlaneRoots,
    scanProtectedPathHashes,
    evaluateProtectedControlPlaneManifest
} from './helpers';
import { detectCodeChanged, preflightRequiresAnyReview } from './preflight-code-change';
import { evaluateIsolationModePostTask, loadIsolationModeConfig } from './isolation-mode';
import { validateSandbox } from './isolation-sandbox';
import {
    detectProtectedDirtyWorkspaceDrift,
    getProtectedDirtyWorkspaceScopeFromPreflight
} from './dirty-worktree-protection';
import { getProtectedManifestLifecycleGuard } from './protected-manifest-guard';
import { getNoOpEvidence } from './no-op';
import { getHandshakeEvidence, getHandshakeEvidenceViolations } from './handshake-diagnostics';
import { getShellSmokeEvidence, getShellSmokeEvidenceViolations } from './shell-smoke-preflight';
import { getRulePackEvidence, getRulePackEvidenceViolations } from './rule-pack';
import { resolveCanonicalReviewContextPath } from './review-context-paths';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from './review-context-contract';
import {
    resolveRuntimeReviewerIdentity,
    resolveReviewerRoutingPolicy
} from './reviewer-routing';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from './task-mode';
import {
    collectOrderedTimelineEvents,
    readJsonArtifact,
    ensurePassedArtifactStatus,
    readOptionalArtifactStringField,
    findLatestRecordedReviewContextPath,
    findLatestTimelineEvent,
    type TimelineEventEntry
} from './completion-evidence';
import {
    REVIEW_CONTRACTS,
    validateStageSequence,
    validateZeroDiffCompletionEvidence,
    validateReviewSkillEvidence,
    validatePreflightForCompletion,
    getReviewArtifactFindingsEvidence
} from './completion-verdict';

import {
    buildCoherentCycleRestartCommand,
    buildReviewCycleRestartCommand
} from './completion-reporting';
// readReviewTrustSummary is intentionally imported for re-export
import {
    buildUnavailableRequiredReviewTrustSummary,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate
} from './task-audit-summary-collectors';
import {
    loadFullSuiteValidationConfig,
    type FullSuiteValidationCycleBinding,
    type FullSuiteValidationResult
} from './full-suite-validation';
import {
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    getProjectMemoryImpactLifecycleEvidence,
    type ProjectMemoryImpactLifecycleEvidence
} from './project-memory-impact';
import { resolveReviewExecutionPolicyModeFromPreflight } from '../core/review-execution-policy';
import { withReviewArtifactReadBarrier } from '../gate-runtime/review-artifacts';

export { detectCodeChanged, preflightRequiresAnyReview } from './preflight-code-change';

export {
    quotePowerShellCliValue,
    buildCoherentCycleRestartCommand,
    buildReviewCycleRestartCommand,
    formatCompletionGateResult
} from './completion-reporting';

export {
    collectOrderedTimelineEvents,
    readJsonArtifact,
    ensurePassedArtifactStatus,
    readOptionalArtifactStringField,
    normalizeTimelineDetailString,
    getTimelineSkillId,
    getTimelineReferencePath,
    eventMatchesReviewSkill,
    eventMatchesStage,
    findLatestTimelineEvent,
    findLatestStageOccurrence,
    findLatestStageOccurrenceInRange,
    findLatestRecordedReviewContextPath
} from './completion-evidence';
export type { TimelineEventEntry } from './completion-evidence';

export {
    STAGE_SEQUENCE_ORDER,
    NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER,
    NON_CODE_STAGE_SEQUENCE_ORDER,
    REVIEW_CONTRACTS,
    EMPTY_REVIEW_MARKERS,
    CANONICAL_REVIEW_SECTION_HEADINGS,
    countCanonicalReviewSectionHeadings,
    validateStageSequence,
    validateZeroDiffCompletionEvidence,
    validateReviewSkillEvidence,
    validatePreflightForCompletion,
    isTrivialReview,
    extractMarkdownSectionLines,
    formatAcceptedReviewSectionHeadingShapes,
    getCanonicalReviewSectionHeading,
    normalizeCanonicalReviewSectionHeadings,
    normalizeReviewListText,
    isMeaningfulReviewEntry,
    getMarkdownMeaningfulEntries,
    getFindingsBySeverity,
    getReviewArtifactFindingsEvidence
} from './completion-verdict';
export type { StageSequenceEvidence, ZeroDiffCompletionEvidence } from './completion-verdict';


export interface RunCompletionGateOptions {
    repoRoot?: string;
    preflightPath: string;
    taskId?: string;
    taskModePath?: string;
    rulePackPath?: string;
    reviewsRoot?: string;
    compileEvidencePath?: string;
    reviewEvidencePath?: string;
    docImpactPath?: string;
    timelinePath?: string;
    noOpArtifactPath?: string;
    handshakePath?: string;
    shellSmokePath?: string;
}

function validateProjectMemoryImpactForCompletion(input: {
    evidence: ProjectMemoryImpactLifecycleEvidence;
    orderedEvents: readonly TimelineEventEntry[];
    fullSuiteValidationEnabled: boolean;
    timelinePath: string;
}): string[] {
    const violations: string[] = [];
    if (!input.evidence.required) {
        return violations;
    }
    if (input.evidence.evidence_status !== 'CURRENT') {
        violations.push(
            `Project memory impact evidence is not current before completion: ${input.evidence.evidence_status}. ` +
            `${input.evidence.visible_summary_line}`
        );
        violations.push(...input.evidence.violations);
        return violations;
    }

    const impactEvent = findLatestTimelineEvent(
        input.orderedEvents,
        (entry) => entry.event_type === PROJECT_MEMORY_IMPACT_ASSESSED_EVENT
    );
    if (!impactEvent) {
        violations.push(`Task timeline '${normalizePath(input.timelinePath)}' is missing ${PROJECT_MEMORY_IMPACT_ASSESSED_EVENT}.`);
        return violations;
    }

    const docImpactEvent = findLatestTimelineEvent(
        input.orderedEvents,
        (entry) => entry.event_type === 'DOC_IMPACT_ASSESSED'
    );
    if (docImpactEvent && impactEvent.sequence <= docImpactEvent.sequence) {
        violations.push('Project memory impact evidence must be recorded after doc-impact-gate for the current completion cycle.');
    }
    if (input.fullSuiteValidationEnabled) {
        const fullSuiteEvent = findLatestTimelineEvent(
            input.orderedEvents,
            (entry) => entry.event_type === 'FULL_SUITE_VALIDATION_PASSED' || entry.event_type === 'FULL_SUITE_VALIDATION_WARNED'
        );
        if (!fullSuiteEvent) {
            violations.push('Project memory impact evidence requires current full-suite validation evidence when full-suite validation is enabled.');
        } else if (impactEvent.sequence <= fullSuiteEvent.sequence) {
            violations.push('Project memory impact evidence must be recorded after full-suite validation for the current completion cycle.');
        }
    }
    return violations;
}

export function runCompletionGate(options: RunCompletionGateOptions) {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const preflightPath = resolvePathInsideRepo(options.preflightPath, repoRoot) as string;
    const validatedPreflight = validatePreflightForCompletion(preflightPath, options.taskId || '');
    const errors: string[] = [...validatedPreflight.errors];
    const resolvedTaskId = validatedPreflight.resolved_task_id;

    const reviewsRoot = options.reviewsRoot
        ? resolvePathInsideRepo(options.reviewsRoot, repoRoot, { allowMissing: true }) as string
        : path.dirname(preflightPath);
    const compileEvidencePath = options.compileEvidencePath
        ? resolvePathInsideRepo(options.compileEvidencePath, repoRoot, { allowMissing: true }) as string
        : path.join(reviewsRoot, `${resolvedTaskId}-compile-gate.json`);
    const reviewEvidencePath = options.reviewEvidencePath
        ? resolvePathInsideRepo(options.reviewEvidencePath, repoRoot, { allowMissing: true }) as string
        : path.join(reviewsRoot, `${resolvedTaskId}-review-gate.json`);
    const docImpactPath = options.docImpactPath
        ? resolvePathInsideRepo(options.docImpactPath, repoRoot, { allowMissing: true }) as string
        : path.join(reviewsRoot, `${resolvedTaskId}-doc-impact.json`);
    const timelinePath = options.timelinePath
        ? resolvePathInsideRepo(options.timelinePath, repoRoot, { allowMissing: true }) as string
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`));
    const taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, options.taskModePath || '');
    const rulePackEvidence = getRulePackEvidence(repoRoot, resolvedTaskId, 'POST_PREFLIGHT', {
        artifactPath: options.rulePackPath || '',
        preflightPath,
        taskModePath: options.taskModePath || ''
    });
    const fullSuiteValidationConfig = loadFullSuiteValidationConfig(repoRoot);
    const noOpEvidence = getNoOpEvidence(repoRoot, resolvedTaskId, options.noOpArtifactPath || '', preflightPath);
    const handshakeEvidence = getHandshakeEvidence(repoRoot, resolvedTaskId, {
        artifactPath: options.handshakePath || '',
        taskModePath: options.taskModePath || '',
        timelinePath
    });
    const shellSmokeEvidence = getShellSmokeEvidence(repoRoot, resolvedTaskId, {
        artifactPath: options.shellSmokePath || '',
        timelinePath
    });

    const preflight = validatedPreflight.preflight || {};
    const dirtyWorkspaceProtectionEvidence = detectProtectedDirtyWorkspaceDrift(
        repoRoot,
        getProtectedDirtyWorkspaceScopeFromPreflight(preflight)
    );
    const preflightTriggers = toPlainRecord(preflight.triggers) || {};
    const preflightProtectedSnapshot = toPlainRecord(preflightTriggers.protected_control_plane_snapshot) || {};
    const hasProtectedSnapshot = Object.prototype.hasOwnProperty.call(preflightTriggers, 'protected_control_plane_snapshot');
    const preflightProtectedSnapshotDigest = String(preflightTriggers.protected_control_plane_snapshot_sha256 || '').trim().toLowerCase();
    const hasProtectedSnapshotDigest = /^[a-f0-9]{64}$/.test(preflightProtectedSnapshotDigest);
    const orchestratorWork = !!taskModeEvidence.orchestrator_work;

    // T-1010: Re-scan protected paths at completion to detect tampering
    // T-1011: When isolation mode is enabled, enforcement level governs
    //         whether drift is a hard error (STRICT) or a logged warning (LOG_ONLY).
    const isolationConfig = loadIsolationModeConfig(repoRoot);
    const isolationWarnings: string[] = [];
    let currentProtectedSnapshot: Record<string, string> | null = null;
    if (hasProtectedSnapshot || hasProtectedSnapshotDigest) {
        currentProtectedSnapshot = scanProtectedPathHashes(
            repoRoot,
            getProtectedControlPlaneRoots(repoRoot)
        );
        const currentProtectedSnapshotDigest = computeProtectedSnapshotDigest(currentProtectedSnapshot);
        let changedFiles: string[] = [];
        let taskMutatedProtectedControlPlane = false;

        if (hasProtectedSnapshot) {
            const allProtectedPaths = new Set([...Object.keys(preflightProtectedSnapshot), ...Object.keys(currentProtectedSnapshot)]);
            for (const p of allProtectedPaths) {
                if (preflightProtectedSnapshot[p] !== currentProtectedSnapshot[p]) {
                    changedFiles.push(p);
                }
            }
            taskMutatedProtectedControlPlane = changedFiles.length > 0;
        } else if (hasProtectedSnapshotDigest) {
            taskMutatedProtectedControlPlane = currentProtectedSnapshotDigest !== preflightProtectedSnapshotDigest;
        }

        if (taskMutatedProtectedControlPlane && !orchestratorWork) {
            const driftMessage = changedFiles.length > 0
                ? `Control-plane files were modified in a non-orchestrator task: ${changedFiles.join(', ')}. ` +
                  'Protected orchestrator runtime paths are only allowed for tasks started with --orchestrator-work.'
                : 'Control-plane files were modified in a non-orchestrator task after the preflight protected snapshot digest changed. ' +
                  'Protected orchestrator runtime paths are only allowed for tasks started with --orchestrator-work.';
            if (isolationConfig.enabled && isolationConfig.enforcement === 'LOG_ONLY') {
                isolationWarnings.push(driftMessage + ' (LOG_ONLY mode — logged as warning)');
            } else {
                errors.push(driftMessage);
            }
        }
    }

    const protectedManifestEvidence = evaluateProtectedControlPlaneManifest(repoRoot, currentProtectedSnapshot);
    const protectedManifestGuard = getProtectedManifestLifecycleGuard({
        repoRoot,
        orchestratorWork,
        phaseLabel: 'completion gate',
        preflight,
        manifestEvidence: protectedManifestEvidence
    });
    if (!orchestratorWork && protectedManifestGuard.status === 'BLOCK') {
        if (isolationConfig.enabled && isolationConfig.enforcement === 'LOG_ONLY') {
            isolationWarnings.push(`${protectedManifestGuard.violations.join(' ')} (LOG_ONLY mode — logged as warning)`);
        } else {
            errors.push(...protectedManifestGuard.violations);
        }
    }

    const compileEvidence = readJsonArtifact(compileEvidencePath, 'Compile gate', errors);
    const docImpactEvidence = readJsonArtifact(docImpactPath, 'Doc impact gate', errors);
    const compileCommandsPath = readOptionalArtifactStringField(compileEvidence, 'commands_path');
    const compileOutputFiltersPath = readOptionalArtifactStringField(compileEvidence, 'output_filters_path');

    ensurePassedArtifactStatus(compileEvidence, 'Compile gate', errors);
    ensurePassedArtifactStatus(docImpactEvidence, 'Doc impact gate', errors);
    errors.push(...getTaskModeEvidenceViolations(taskModeEvidence));
    errors.push(...getRulePackEvidenceViolations(rulePackEvidence));
    errors.push(...getHandshakeEvidenceViolations(handshakeEvidence));
    errors.push(...getShellSmokeEvidenceViolations(shellSmokeEvidence));
    errors.push(...dirtyWorkspaceProtectionEvidence.violations);

    // T-1011: post-task isolation mode enforcement (complements T-1010 drift check above)
    if (hasProtectedSnapshot && !orchestratorWork && isolationConfig.enabled) {
        const typedSnapshot: Record<string, string> = {};
        for (const [k, v] of Object.entries(preflightProtectedSnapshot)) {
            typedSnapshot[k] = String(v);
        }
        const isolationEvidence = evaluateIsolationModePostTask(repoRoot, typedSnapshot);
        errors.push(...isolationEvidence.violations);
        isolationWarnings.push(...isolationEvidence.warnings);
    }

    // T-1011: Sandbox integrity check at completion
    if (isolationConfig.enabled && isolationConfig.use_sandbox && !orchestratorWork) {
        const sandboxState = validateSandbox(repoRoot);
        if (sandboxState.exists) {
            if (sandboxState.drift_files.length > 0) {
                const sbMessage = `Isolation sandbox was modified during task (${sandboxState.drift_files.length} file(s) drifted). ` +
                    'This indicates the sandbox was tampered with during execution.';
                if (isolationConfig.enforcement === 'STRICT') {
                    errors.push(sbMessage);
                } else {
                    isolationWarnings.push(sbMessage + ' (LOG_ONLY mode — logged as warning)');
                }
            }
            if (!sandboxState.read_only_intact) {
                isolationWarnings.push(
                    'Isolation sandbox read-only flags were removed on some files. ' +
                    'Same-user limitation: read-only attributes are advisory, not a security boundary.'
                );
            }
        }
    }

    const timelineErrors: string[] = [];
    const orderedEvents = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    const timelineEventTypes = new Set(orderedEvents.map(e => e.event_type));
    const codeChanged = detectCodeChanged(validatedPreflight.preflight, repoRoot);
    const reviewRecordedRequired = preflightRequiresAnyReview(validatedPreflight.preflight);
    const latestCompileGatePassedTimestamp = [...orderedEvents]
        .reverse()
        .find((entry) => entry.event_type === 'COMPILE_GATE_PASSED')
        ?.timestamp_utc ?? null;

    errors.push(...timelineErrors);

    if (!timelineEventTypes.has('TASK_MODE_ENTERED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing TASK_MODE_ENTERED.`);
    }
    if (!timelineEventTypes.has('RULE_PACK_LOADED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing RULE_PACK_LOADED.`);
    }
    if (!timelineEventTypes.has('HANDSHAKE_DIAGNOSTICS_RECORDED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing HANDSHAKE_DIAGNOSTICS_RECORDED. Run handshake-diagnostics before preflight.`);
    }
    if (!timelineEventTypes.has('SHELL_SMOKE_PREFLIGHT_RECORDED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing SHELL_SMOKE_PREFLIGHT_RECORDED. Run shell-smoke-preflight before preflight.`);
    }
    if (!timelineEventTypes.has('COMPILE_GATE_PASSED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing COMPILE_GATE_PASSED.`);
    }
    if (reviewRecordedRequired && !timelineEventTypes.has('REVIEW_PHASE_STARTED')) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing REVIEW_PHASE_STARTED.`);
    }
    if (
        !timelineEventTypes.has('REVIEW_GATE_PASSED')
        && !timelineEventTypes.has('REVIEW_GATE_PASSED_WITH_OVERRIDE')
    ) {
        errors.push(`Task timeline '${normalizePath(timelinePath)}' is missing REVIEW_GATE_PASSED.`);
    }

    const zeroDiffEvidence = validateZeroDiffCompletionEvidence(
        validatedPreflight.preflight,
        resolvedTaskId || '',
        taskModeEvidence.task_summary,
        noOpEvidence
    );
    errors.push(...zeroDiffEvidence.violations);

    const stageSequence = validateStageSequence(orderedEvents, codeChanged, timelinePath, reviewRecordedRequired);
    errors.push(...stageSequence.violations);

    const requiredReviews = validatedPreflight.preflight && typeof validatedPreflight.preflight.required_reviews === 'object'
        ? validatedPreflight.preflight.required_reviews
        : {};
    const reviewArtifacts: Record<string, {
        path: string;
        content: string;
        reviewContextPath: string;
        reviewContext: Record<string, unknown> | null;
        receipt: ReviewReceipt | null;
        findings_evidence: ReturnType<typeof getReviewArtifactFindingsEvidence>;
    }> = {};
    const runtimeIdentity = resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId: resolvedTaskId,
        taskModePath: options.taskModePath || '',
        allowLegacyFallback: true
    });
    const executionProvider = runtimeIdentity.execution_provider;
    if (runtimeIdentity.identity_status !== 'resolved') {
        errors.push(
            `Runtime reviewer identity must stay resolved for completion, got '${runtimeIdentity.identity_status}'.`
        );
    }
    errors.push(...runtimeIdentity.violations);
    const scopeCategory = typeof preflight.scope_category === 'string' ? preflight.scope_category : null;

    const {
        receiptReviewTrustSummary,
        reviewGateTrustSummary
    } = withReviewArtifactReadBarrier(reviewsRoot, () => {
        const reviewEvidence = readJsonArtifact(reviewEvidencePath, 'Review gate', errors);
        ensurePassedArtifactStatus(reviewEvidence, 'Review gate', errors);
        for (const [reviewKey] of REVIEW_CONTRACTS) {
            const required = !!requiredReviews[reviewKey];
            if (!required) {
                continue;
            }
            const artifactPath = path.join(reviewsRoot, `${resolvedTaskId}-${reviewKey}.md`);
            const recordedReviewContextPath = findLatestRecordedReviewContextPath(orderedEvents, reviewKey);
            const reviewContextPath = resolveCanonicalReviewContextPath({
                reviewsRoot,
                taskId: resolvedTaskId,
                reviewType: reviewKey,
                explicitPath: recordedReviewContextPath
            });
            const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
            const artifactExists = fs.existsSync(artifactPath) && fs.statSync(artifactPath).isFile();

            if (!artifactExists) {
                if (required) {
                    errors.push(`Required review artifact not found: ${normalizePath(artifactPath)}`);
                }
                continue;
            }

            const artifactContent = fs.readFileSync(artifactPath, 'utf8');
            let reviewContext: Record<string, unknown> | null = null;
            let receipt: ReviewReceipt | null = null;
            if (fs.existsSync(reviewContextPath) && fs.statSync(reviewContextPath).isFile()) {
                try {
                    const parsedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
                    if (parsedReviewContext && typeof parsedReviewContext === 'object' && !Array.isArray(parsedReviewContext)) {
                        reviewContext = parsedReviewContext as Record<string, unknown>;
                        if (required) {
                            errors.push(...getReviewContextContractViolations({
                                contextPath: reviewContextPath,
                                reviewContext,
                                expectedTaskId: resolvedTaskId,
                                expectedReviewType: reviewKey,
                                expectedPreflightPath: validatedPreflight.preflight_path,
                                expectedPreflightSha256: validatedPreflight.preflight_hash,
                                requireReviewType: true,
                                requireTaskId: true,
                                requirePreflightPath: true,
                                requirePreflightSha256: true,
                                ...buildReviewContextPreflightDiffExpectations(validatedPreflight.preflight, reviewKey)
                            }));
                        }
                    }
                } catch {
                    if (required) {
                        errors.push(`Required review-context artifact is invalid JSON: ${normalizePath(reviewContextPath)}`);
                    }
                }
            } else if (required) {
                errors.push(`Required review-context artifact not found: ${normalizePath(reviewContextPath)}`);
            }
            if (fs.existsSync(receiptPath) && fs.statSync(receiptPath).isFile()) {
                try {
                    const parsedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
                    if (parsedReceipt && typeof parsedReceipt === 'object' && !Array.isArray(parsedReceipt)) {
                        receipt = parsedReceipt as ReviewReceipt;
                    }
                } catch {
                    if (required) {
                        errors.push(`Required review receipt is invalid JSON: ${normalizePath(receiptPath)}`);
                    }
                }
            } else if (required) {
                errors.push(`Required review receipt not found: ${normalizePath(receiptPath)}`);
            }
            const findingsEvidence = getReviewArtifactFindingsEvidence(artifactPath, artifactContent);
            reviewArtifacts[reviewKey] = {
                path: normalizePath(artifactPath),
                content: artifactContent,
                reviewContextPath: normalizePath(reviewContextPath),
                reviewContext,
                receipt,
                findings_evidence: findingsEvidence
            };
            if (Array.isArray(findingsEvidence.violations) && findingsEvidence.violations.length > 0) {
                errors.push(...findingsEvidence.violations);
            }
        }
        const receiptReviewTrustSummary = readReviewTrustSummary(
            requiredReviews,
            reviewsRoot,
            resolvedTaskId || '',
            scopeCategory,
            validatedPreflight.preflight_hash
        );
        const reviewGateTrustSummary = readReviewTrustSummaryFromReviewGate(
            reviewEvidence && typeof reviewEvidence === 'object' && !Array.isArray(reviewEvidence)
                ? reviewEvidence as Record<string, unknown>
                : null,
            requiredReviews,
            resolvedTaskId || '',
            scopeCategory,
            validatedPreflight.preflight_hash
        );
        return {
            receiptReviewTrustSummary,
            reviewGateTrustSummary
        };
    });

    // T-003: review-skill invocation evidence for code-changing tasks
    const reviewSkillEvidence = validateReviewSkillEvidence(
        orderedEvents,
        requiredReviews,
        reviewArtifacts,
        codeChanged,
        timelinePath,
        executionProvider,
        runtimeIdentity.canonical_source_of_truth,
        runtimeIdentity.task_mode_identity_backfilled,
        runtimeIdentity.execution_provider_source,
        resolveReviewExecutionPolicyModeFromPreflight(preflight),
        repoRoot
    );
    errors.push(...reviewSkillEvidence.violations);

    stageSequence.review_skill_ids = reviewSkillEvidence.skill_ids;
    stageSequence.review_skill_reference_paths = reviewSkillEvidence.reference_paths;
    stageSequence.review_artifact_keys = reviewSkillEvidence.artifact_keys;
    stageSequence.reviewer_execution_modes = reviewSkillEvidence.reviewer_execution_modes;

    // T-1005: Build reviewer routing enforcement summary
    const routingPolicy = resolveReviewerRoutingPolicy(executionProvider, runtimeIdentity.execution_provider_source);
    const reviewerRoutingEnforcement = {
        canonical_source_of_truth: runtimeIdentity.canonical_source_of_truth,
        canonical_entrypoint: runtimeIdentity.canonical_entrypoint,
        execution_provider: runtimeIdentity.execution_provider,
        execution_provider_source: runtimeIdentity.execution_provider_source,
        routed_to: runtimeIdentity.routed_to,
        provider_bridge: runtimeIdentity.provider_bridge,
        identity_status: runtimeIdentity.identity_status,
        identity_violations: runtimeIdentity.violations,
        source_of_truth: routingPolicy.source_of_truth,
        capability_level: routingPolicy.capability_level,
        delegation_required: routingPolicy.delegation_required,
        expected_execution_mode: routingPolicy.expected_execution_mode,
        fallback_allowed: routingPolicy.fallback_allowed,
        fallback_reason_required: routingPolicy.fallback_reason_required,
        observed_execution_modes: reviewSkillEvidence.reviewer_execution_modes,
        enforcement_level: 'hard_block'
    };
    const hasRequiredReviews = Object.values(requiredReviews).some((value) => value === true);
    const reviewTrustSummary = reviewGateTrustSummary
        ?? (hasRequiredReviews
            ? buildUnavailableRequiredReviewTrustSummary(requiredReviews, scopeCategory)
            : receiptReviewTrustSummary);

    // Plan metadata from task-mode evidence (informational, never blocks)
    const planEvidence = {
        plan_guided: !!taskModeEvidence.plan,
        plan_path: taskModeEvidence.plan?.plan_path ?? null,
        plan_sha256: taskModeEvidence.plan?.plan_sha256 ?? null,
        plan_summary: taskModeEvidence.plan?.plan_summary ?? null
    };

    const fullSuiteValidationPath = path.join(reviewsRoot, `${resolvedTaskId}-full-suite-validation.json`);
    const fullSuiteValidationEvidence: {
        enabled: boolean;
        artifact_path: string;
        status: string | null;
        cycle_binding: FullSuiteValidationCycleBinding | null;
        cycle_binding_valid: boolean | null;
        violations: string[];
    } = {
        enabled: fullSuiteValidationConfig.enabled,
        artifact_path: normalizePath(fullSuiteValidationPath),
        status: null,
        cycle_binding: null,
        cycle_binding_valid: null,
        violations: []
    };

    if (fullSuiteValidationConfig.enabled) {
        const fullSuiteArtifact = readJsonArtifact(fullSuiteValidationPath, 'Full suite validation', errors) as FullSuiteValidationResult | null;
        const hasFullSuiteTimelineEvent =
            timelineEventTypes.has('FULL_SUITE_VALIDATION_PASSED')
            || timelineEventTypes.has('FULL_SUITE_VALIDATION_WARNED')
            || timelineEventTypes.has('FULL_SUITE_VALIDATION_FAILED')
            || timelineEventTypes.has('FULL_SUITE_VALIDATION_SKIPPED');
        if (!hasFullSuiteTimelineEvent) {
            const message = `Task timeline '${normalizePath(timelinePath)}' is missing full-suite validation lifecycle evidence.`;
            errors.push(message);
            fullSuiteValidationEvidence.violations.push(message);
        }

        if (!fullSuiteArtifact) {
            fullSuiteValidationEvidence.status = 'MISSING';
        } else {
            const artifactStatus = String(fullSuiteArtifact.status || '').trim().toUpperCase();
            fullSuiteValidationEvidence.status = artifactStatus || null;
            const rawCycleBinding = fullSuiteArtifact.cycle_binding;
            if (!rawCycleBinding || typeof rawCycleBinding !== 'object' || Array.isArray(rawCycleBinding)) {
                const message = `Full suite validation artifact '${normalizePath(fullSuiteValidationPath)}' is missing cycle_binding.`;
                errors.push(message);
                fullSuiteValidationEvidence.violations.push(message);
            } else {
                const cycleBindingRecord = rawCycleBinding as unknown as Record<string, unknown>;
                const cycleBinding: FullSuiteValidationCycleBinding = {
                    task_id: String(cycleBindingRecord.task_id || '').trim(),
                    preflight_path: normalizePath(cycleBindingRecord.preflight_path || ''),
                    preflight_sha256: String(cycleBindingRecord.preflight_sha256 || '').trim().toLowerCase(),
                    compile_gate_timestamp: cycleBindingRecord.compile_gate_timestamp == null
                        ? null
                        : String(cycleBindingRecord.compile_gate_timestamp || '').trim() || null
                };
                fullSuiteValidationEvidence.cycle_binding = cycleBinding;
                const expectedCycleBinding: FullSuiteValidationCycleBinding = {
                    task_id: String(resolvedTaskId || '').trim(),
                    preflight_path: normalizePath(validatedPreflight.preflight_path),
                    preflight_sha256: String(validatedPreflight.preflight_hash || '').trim().toLowerCase(),
                    compile_gate_timestamp: latestCompileGatePassedTimestamp
                };
                const cycleBindingValid =
                    cycleBinding.task_id === expectedCycleBinding.task_id
                    && cycleBinding.preflight_path === expectedCycleBinding.preflight_path
                    && cycleBinding.preflight_sha256 === expectedCycleBinding.preflight_sha256
                    && cycleBinding.compile_gate_timestamp === expectedCycleBinding.compile_gate_timestamp;
                fullSuiteValidationEvidence.cycle_binding_valid = cycleBindingValid;
                if (!cycleBindingValid) {
                    const message =
                        `Full suite validation artifact '${normalizePath(fullSuiteValidationPath)}' is stale for the current task cycle. ` +
                        `Expected task_id='${expectedCycleBinding.task_id}', preflight_path='${expectedCycleBinding.preflight_path}', ` +
                        `preflight_sha256='${expectedCycleBinding.preflight_sha256}', compile_gate_timestamp='${expectedCycleBinding.compile_gate_timestamp || 'null'}'.`;
                    errors.push(message);
                    fullSuiteValidationEvidence.violations.push(message);
                }
            }

            if (artifactStatus !== 'PASSED' && artifactStatus !== 'WARNED') {
                const message =
                    `Full suite validation artifact '${normalizePath(fullSuiteValidationPath)}' must have status PASSED or WARNED when enabled, got '${artifactStatus || 'UNKNOWN'}'.`;
                errors.push(message);
                fullSuiteValidationEvidence.violations.push(message);
            }
        }
    } else {
        fullSuiteValidationEvidence.status = 'NOT_REQUIRED';
    }

    const projectMemoryImpactEvidence = getProjectMemoryImpactLifecycleEvidence({
        repoRoot,
        taskId: resolvedTaskId || '',
        preflightPath
    });
    errors.push(...validateProjectMemoryImpactForCompletion({
        evidence: projectMemoryImpactEvidence,
        orderedEvents,
        fullSuiteValidationEnabled: fullSuiteValidationConfig.enabled,
        timelinePath
    }));

    const status = errors.length > 0 ? 'FAILED' : 'PASSED';
    const outcome = errors.length > 0 ? 'FAIL' : 'PASS';
    const coherentCycleRestartCommand = stageSequence.violations.length > 0 && resolvedTaskId
        ? buildCoherentCycleRestartCommand(
            repoRoot,
            resolvedTaskId,
            normalizePath(preflightPath),
            taskModeEvidence.evidence_path,
            compileCommandsPath,
            compileOutputFiltersPath
        )
        : null;
    const reviewCycleRecoveryRelevant = resolvedTaskId
        && stageSequence.violations.length === 0
        && errors.length > 0
        && (
            reviewSkillEvidence.violations.length > 0
            || (!timelineEventTypes.has('REVIEW_GATE_PASSED') && !timelineEventTypes.has('REVIEW_GATE_PASSED_WITH_OVERRIDE'))
            || REVIEW_CONTRACTS.some(([reviewKey]) => {
                if (!requiredReviews[reviewKey]) {
                    return false;
                }
                const artifact = reviewArtifacts[reviewKey];
                if (!artifact) {
                    return true;
                }
                return !artifact.content
                    || !artifact.reviewContext
                    || !artifact.receipt
                    || artifact.findings_evidence.violations.length > 0;
            })
        );
    const reviewCycleRestartCommand = reviewCycleRecoveryRelevant
        ? buildReviewCycleRestartCommand(
            repoRoot,
            resolvedTaskId,
            normalizePath(preflightPath),
            taskModeEvidence.evidence_path,
            compileCommandsPath,
            compileOutputFiltersPath
        )
        : null;

    return {
        status,
        outcome,
        task_id: resolvedTaskId,
        preflight_path: normalizePath(preflightPath),
        reviews_root: normalizePath(reviewsRoot),
        task_mode_path: taskModeEvidence.evidence_path,
        rule_pack_path: rulePackEvidence.evidence_path,
        handshake_path: handshakeEvidence.evidence_path,
        shell_smoke_path: shellSmokeEvidence.evidence_path,
        compile_evidence_path: normalizePath(compileEvidencePath),
        review_evidence_path: normalizePath(reviewEvidencePath),
        doc_impact_path: normalizePath(docImpactPath),
        timeline_path: normalizePath(timelinePath),
        review_artifacts: reviewArtifacts,
        scope_category: scopeCategory,
        stage_sequence_evidence: stageSequence,
        reviewer_routing_enforcement: reviewerRoutingEnforcement,
        review_trust_summary: reviewTrustSummary,
        full_suite_validation_evidence: fullSuiteValidationEvidence,
        project_memory_impact_evidence: projectMemoryImpactEvidence,
        zero_diff_evidence: zeroDiffEvidence,
        dirty_workspace_protection_evidence: dirtyWorkspaceProtectionEvidence,
        plan: planEvidence,
        isolation_mode_warnings: isolationWarnings,
        coherent_cycle_restart_command: coherentCycleRestartCommand,
        review_cycle_restart_command: reviewCycleRestartCommand,
        violations: errors
    };
}
