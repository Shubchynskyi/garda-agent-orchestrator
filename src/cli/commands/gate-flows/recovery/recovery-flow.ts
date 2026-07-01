import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import {
    getReviewExecutionPreparationBatches,
    resolveReviewExecutionPolicyModeFromPreflight
} from '../../../../core/review-execution-policy';
import {
    appendMandatoryTaskEvent,
    assertValidTaskId
} from '../../../../gate-runtime/task-events';
import { type TokenEconomyConfig } from '../../../../gates/review-context/review-context-token-economy';
import { getClassificationConfig } from '../../../../gates/preflight/classify-change';
import { buildScopedDiff, resolveMetadataPath as resolveScopedDiffMetadataPath, resolveOutputPath as resolveScopedDiffOutputPath } from '../../../../gates/preflight/build-scoped-diff';
import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import {
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigChangedFiles
} from '../../../../gates/workflow-config/workflow-config-work';
import { buildReviewContextPreflightDiffExpectations } from '../../../../gates/review-context/review-context-contract';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../../../../gates/task-mode/task-mode';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    type CompileGateCommandOptions
} from '../compile/compile-flow';
import {
    resolveDefaultReviewsPath,
    writeJsonArtifact
} from '../../gates/gates-artifacts';
import {
    resolveOrchestratorRoot
} from '../compile/gate-flow-helpers';
import {
    runBuildReviewContextCommand,
    readTimelineEventsSummary,
    type BuildReviewContextCommandResult
} from '../../gate-build-handlers';
import {
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runShellSmokePreflightCommand
} from '../task-mode/task-mode-flow';
import { resolveGateExecutionPath } from '../../../../gates/isolation/isolation-sandbox';
import { resolveRuntimeReviewerIdentity } from '../../../../gates/review/reviewer-routing';
import {
    assessReviewRemediationScopeBoundary,
    classifyReviewRemediationFix,
    getTaskManualValidationBoundaryFiles,
    REMEDIATION_IMPACT_ANALYSIS_TOPICS,
    resolveCurrentRemediationChangedFiles,
    resolveReviewRemediationClassifyChangedFiles,
    resolveReviewRemediationImpactAnalysis,
    writeReviewRemediationCycleArtifact
} from './recovery-flow-remediation';
import {
    getEffectiveDepthFromPreflight,
    getReviewCyclePrePreflightRefreshPlan,
    normalizeRuleFileList,
    resolveReplayScope,
    resolveReviewCycleReplayScope,
    TASK_ENTRY_RULE_FILES
} from './recovery-flow-replay-scope';
import {
    buildCoherentCycleRestartedOutput,
    buildReviewCycleRestartedOutput
} from './recovery-flow-rendering';
import { normalizeChangedFiles } from './recovery-flow-shared';
import type {
    RestartCoherentCycleCommandOptions,
    RestartReviewCycleCommandOptions,
    ReviewRemediationImpactAnalysis
} from './recovery-flow-types';

export type {
    RestartCoherentCycleCommandOptions,
    RestartReviewCycleCommandOptions
} from './recovery-flow-types';

function getDependencyBlockReason(error: unknown, reviewType: string): string | null {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(`ReviewType '${reviewType}' is blocked until upstream reviews pass for the current cycle:`)) {
        return null;
    }
    return message.trim();
}

function ensureStepPassed(stepName: string, result: { outputLines: string[]; exitCode: number }): void {
    if (result.exitCode !== 0) {
        throw new Error(`${stepName} failed during coherent-cycle restart.\n${result.outputLines.join('\n')}`.trim());
    }
}

function resolveRecoveryPreflightPath(
    repoRoot: string,
    taskId: string,
    pathValue: unknown,
    label: string
): string {
    const defaultPreflightPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-preflight.json`)
    );
    const requestedPath = String(pathValue || defaultPreflightPath).trim() || defaultPreflightPath;
    const resolvedPath = gateHelpers.resolvePathInsideRepo(requestedPath, repoRoot, { allowMissing: true });
    if (!resolvedPath || !gateHelpers.isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: true })) {
        throw new Error(
            `${label} must resolve inside repo root without symlink or junction escape: `
            + gateHelpers.normalizePath(resolvedPath || requestedPath)
        );
    }
    return resolvedPath;
}

function requireArtifactSha256(artifactPath: string, label: string): string {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        throw new Error(`${label} artifact is missing after restart success: ${gateHelpers.normalizePath(artifactPath)}`);
    }
    const sha256 = gateHelpers.fileSha256(artifactPath);
    if (!sha256) {
        throw new Error(`${label} artifact hash could not be computed after restart success: ${gateHelpers.normalizePath(artifactPath)}`);
    }
    return sha256;
}

function toNonNegativeCount(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function appendRestartCompletedEvidence(input: {
    repoRoot: string;
    taskId: string;
    eventType: 'COHERENT_CYCLE_RESTARTED' | 'REVIEW_CYCLE_RESTARTED';
    artifactSuffix: '-coherent-cycle-restart.json' | '-review-cycle-restart.json';
    message: string;
    taskModePath: string;
    preflightPath: string;
    compileEvidencePath: string;
    detectionSource: string;
    plannedChangedFilesCount: number;
    detectedChangedFilesCount: number;
    elapsedMs: number;
    restartReason: string;
    nextStepSummary: string;
    extraDetails?: Record<string, unknown>;
}): void {
    const artifactPath = resolveDefaultReviewsPath(input.repoRoot, `${input.taskId}${input.artifactSuffix}`);
    const baseDetails = {
        restart_event_schema_version: 1,
        task_id: input.taskId,
        event_type: input.eventType,
        status: 'PASSED',
        task_mode_path: gateHelpers.normalizePath(input.taskModePath),
        task_mode_sha256: requireArtifactSha256(input.taskModePath, 'task-mode'),
        preflight_path: gateHelpers.normalizePath(input.preflightPath),
        preflight_sha256: requireArtifactSha256(input.preflightPath, 'preflight'),
        compile_evidence_path: gateHelpers.normalizePath(input.compileEvidencePath),
        compile_evidence_sha256: requireArtifactSha256(input.compileEvidencePath, 'compile-gate'),
        detection_source: input.detectionSource,
        planned_changed_files_count: input.plannedChangedFilesCount,
        detected_changed_files_count: input.detectedChangedFilesCount,
        elapsed_ms: Math.max(0, Math.floor(input.elapsedMs)),
        restart_reason: input.restartReason,
        next_step_summary: input.nextStepSummary,
        ...(input.extraDetails || {})
    };
    writeJsonArtifact(artifactPath, {
        schema_version: 1,
        event_source: input.eventType === 'COHERENT_CYCLE_RESTARTED'
            ? 'restart-coherent-cycle'
            : 'restart-review-cycle',
        recorded_at_utc: new Date().toISOString(),
        ...baseDetails
    });
    const restartArtifactSha256 = requireArtifactSha256(artifactPath, 'restart-cycle');
    appendMandatoryTaskEvent(
        resolveOrchestratorRoot(input.repoRoot),
        input.taskId,
        input.eventType,
        'PASS',
        input.message,
        {
            ...baseDetails,
            restart_artifact_path: gateHelpers.normalizePath(artifactPath),
            restart_artifact_sha256: restartArtifactSha256
        },
        { actor: 'orchestrator' }
    );
}

function toPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function getWorkflowConfigPathList(value: unknown): string[] {
    return Array.isArray(value)
        ? getWorkflowConfigChangedFiles(value.map((entry) => String(entry || '')))
        : [];
}

function getWorkflowConfigHashEvidence(value: unknown): Record<string, string | null> {
    const record = toPlainRecord(value);
    if (!record) {
        return {};
    }
    const hashes: Record<string, string | null> = {};
    for (const [rawPath, rawHash] of Object.entries(record)) {
        const [normalizedPath] = getWorkflowConfigChangedFiles([rawPath]);
        if (!normalizedPath) {
            continue;
        }
        if (rawHash === null) {
            hashes[normalizedPath] = null;
            continue;
        }
        const hashText = String(rawHash || '').trim().toLowerCase();
        if (/^[a-f0-9]{64}$/.test(hashText)) {
            hashes[normalizedPath] = hashText;
        }
    }
    return hashes;
}

function resolveRestartAllowedDirtyWorkflowConfigFiles(
    repoRoot: string,
    previousPreflight: ReturnType<typeof getPreflightContext>,
    plannedChangedFiles: readonly string[]
): string[] {
    const preflightRecord = toPlainRecord(previousPreflight.preflight);
    const triggers = toPlainRecord(preflightRecord?.triggers);
    const preflightWorkflowConfigFiles = new Set([
        ...getWorkflowConfigChangedFiles(previousPreflight.changed_files.map((entry) => String(entry || ''))),
        ...getWorkflowConfigPathList(triggers?.changed_workflow_config_files)
    ]);
    const previousHashEvidence = getWorkflowConfigHashEvidence(triggers?.workflow_config_file_hashes);
    if (preflightWorkflowConfigFiles.size === 0 || Object.keys(previousHashEvidence).length === 0) {
        return [];
    }
    const currentHashes = getCurrentWorkflowConfigFileHashes(repoRoot);
    return getWorkflowConfigChangedFiles(plannedChangedFiles)
        .filter((relativePath) => (
            preflightWorkflowConfigFiles.has(relativePath)
            && Object.prototype.hasOwnProperty.call(previousHashEvidence, relativePath)
            && (currentHashes[relativePath] ?? null) === previousHashEvidence[relativePath]
        ))
        .sort();
}

export async function runRestartCoherentCycleCommand(
    options: RestartCoherentCycleCommandOptions
): Promise<{ outputLines: string[]; exitCode: number }> {
    const startedAt = Date.now();
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const resolvedTaskId = assertValidTaskId(String(options.taskId || '').trim());
    const previousTaskMode = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
    const taskModeViolations = getTaskModeEvidenceViolations(previousTaskMode);
    if (taskModeViolations.length > 0) {
        throw new Error(taskModeViolations.join(' '));
    }

    const resolvedTaskModePath = String(options.taskModePath || previousTaskMode.evidence_path || '').trim();
    const resolvedPreflightPath = resolveRecoveryPreflightPath(
        repoRoot,
        resolvedTaskId,
        options.preflightPath,
        'PreflightPath'
    );
    const previousPreflight = getPreflightContext(resolvedPreflightPath, resolvedTaskId);
    const replayScope = resolveReplayScope(options, previousPreflight);
    const taskSummary = String(options.taskIntent || previousTaskMode.task_summary || '').trim();
    if (!taskSummary) {
        throw new Error('Task intent could not be resolved for coherent-cycle restart.');
    }
    const allowedDirtyWorkflowConfigFiles = previousTaskMode.orchestrator_work === true
        && previousTaskMode.workflow_config_work === true
        ? resolveRestartAllowedDirtyWorkflowConfigFiles(repoRoot, previousPreflight, replayScope.plannedChangedFiles)
        : [];

    try {
        ensureStepPassed('enter-task-mode', runEnterTaskModeCommand({
            repoRoot,
            taskId: resolvedTaskId,
            artifactPath: resolvedTaskModePath,
            entryMode: previousTaskMode.entry_mode || 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: previousTaskMode.requested_depth || 2,
            effectiveDepth: previousTaskMode.effective_depth || previousTaskMode.requested_depth || 2,
            taskSummary,
            startBanner: previousTaskMode.start_banner,
            plannedChangedFiles: replayScope.plannedChangedFiles,
            orchestratorWork: previousTaskMode.orchestrator_work === true,
            workflowConfigWork: previousTaskMode.workflow_config_work === true,
            operatorConfirmed: options.operatorConfirmed,
            operatorConfirmedAtUtc: options.operatorConfirmedAtUtc,
            allowedDirtyWorkflowConfigFiles,
            workflowConfigFileHashesOverride: previousTaskMode.workflow_config_file_hashes,
            workflowConfigCompatibilityBaselineFilesOverride: previousTaskMode.workflow_config_compatibility_baseline_files,
            provider: previousTaskMode.provider || undefined,
            routedTo: previousTaskMode.routed_to || undefined,
            planPath: previousTaskMode.plan?.plan_path || undefined,
            emitMetrics: options.emitMetrics
        }));

        ensureStepPassed('load-rule-pack (TASK_ENTRY)', runLoadRulePackCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            stage: 'TASK_ENTRY',
            loadedRuleFiles: TASK_ENTRY_RULE_FILES,
            emitMetrics: options.emitMetrics
        }));

        ensureStepPassed('handshake-diagnostics', runHandshakeDiagnosticsCommand({
            repoRoot,
            taskId: resolvedTaskId,
            provider: previousTaskMode.provider || undefined,
            emitMetrics: options.emitMetrics
        }));

        ensureStepPassed('shell-smoke-preflight', runShellSmokePreflightCommand({
            repoRoot,
            taskId: resolvedTaskId,
            provider: previousTaskMode.provider || undefined,
            emitMetrics: options.emitMetrics
        }));

        const refreshedPreflightPath = resolveRecoveryPreflightPath(
            repoRoot,
            resolvedTaskId,
            options.preflightOutputPath || resolvedPreflightPath,
            'PreflightOutputPath'
        );
        const classifyResult = runClassifyChangeCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            outputPath: refreshedPreflightPath,
            taskIntent: taskSummary,
            changedFiles: replayScope.changedFiles,
            useStaged: replayScope.useStaged,
            includeUntracked: replayScope.includeUntracked,
            emitMetrics: options.emitMetrics
        });
        const refreshedPreflight = getPreflightContext(refreshedPreflightPath, resolvedTaskId);
        const refreshedRequiredReviews = refreshedPreflight.preflight.required_reviews as Record<string, boolean>;
        const effectiveDepth = getEffectiveDepthFromPreflight(previousTaskMode, refreshedPreflight);

        ensureStepPassed('load-rule-pack (POST_PREFLIGHT)', runLoadRulePackCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            stage: 'POST_PREFLIGHT',
            preflightPath: refreshedPreflightPath,
            loadedRuleFiles: normalizeRuleFileList(refreshedRequiredReviews, effectiveDepth),
            emitMetrics: options.emitMetrics
        }));

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            preflightPath: refreshedPreflightPath,
            commandsPath: options.commandsPath,
            outputFiltersPath: options.outputFiltersPath,
            failTailLines: options.failTailLines,
            emitMetrics: options.emitMetrics
        } as CompileGateCommandOptions);
        ensureStepPassed('compile-gate', compileResult);
        const nextStepSummary = 'materialize review artifacts for the new compile cycle, then rerun required-reviews-check, doc-impact-gate, and completion-gate.';
        appendRestartCompletedEvidence({
            repoRoot,
            taskId: resolvedTaskId,
            eventType: 'COHERENT_CYCLE_RESTARTED',
            artifactSuffix: '-coherent-cycle-restart.json',
            message: 'Coherent task cycle restarted after compile gate pass.',
            taskModePath: resolvedTaskModePath,
            preflightPath: refreshedPreflightPath,
            compileEvidencePath: resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`),
            detectionSource: replayScope.detectionSource,
            plannedChangedFilesCount: replayScope.plannedChangedFiles.length,
            detectedChangedFilesCount: toNonNegativeCount(
                refreshedPreflight.changed_files_count,
                refreshedPreflight.changed_files.length
            ),
            elapsedMs: Date.now() - startedAt,
            restartReason: 'coherent_cycle_restart_after_downstream_boundary_or_invalid_preflight_order',
            nextStepSummary
        });

        return {
            outputLines: buildCoherentCycleRestartedOutput({
                taskId: resolvedTaskId,
                taskModePath: resolvedTaskModePath,
                preflightPath: refreshedPreflightPath,
                detectionSource: replayScope.detectionSource,
                plannedChangedFilesCount: replayScope.plannedChangedFiles.length,
                changedFilesCount: refreshedPreflight.changed_files_count,
                preflightSummary: classifyResult.outputText
            }),
            exitCode: 0
        };
    } catch (error: unknown) {
        return {
            outputLines: [
                'COHERENT_CYCLE_RESTART_FAILED',
                `TaskId: ${resolvedTaskId}`,
                error instanceof Error ? error.message : String(error)
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
}

export async function runRestartReviewCycleCommand(
    options: RestartReviewCycleCommandOptions
): Promise<{ outputLines: string[]; exitCode: number }> {
    const startedAt = Date.now();
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const resolvedTaskId = assertValidTaskId(String(options.taskId || '').trim());
    const previousTaskMode = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
    const taskModeViolations = getTaskModeEvidenceViolations(previousTaskMode);
    if (taskModeViolations.length > 0) {
        throw new Error(taskModeViolations.join(' '));
    }

    const resolvedTaskModePath = String(options.taskModePath || previousTaskMode.evidence_path || '').trim();
    const resolvedPreflightPath = resolveRecoveryPreflightPath(
        repoRoot,
        resolvedTaskId,
        options.preflightPath,
        'PreflightPath'
    );
    const previousPreflight = getPreflightContext(resolvedPreflightPath, resolvedTaskId);
    const replayScope = resolveReviewCycleReplayScope(options, previousPreflight, previousTaskMode);
    const previousChangedFiles = normalizeChangedFiles(previousPreflight.changed_files as unknown[]);
    const currentRemediationChangedFiles = resolveCurrentRemediationChangedFiles(repoRoot, replayScope);
    const taskModeArtifactRelativePath = resolvedTaskModePath
        ? gateHelpers.normalizePath(path.relative(repoRoot, path.resolve(resolvedTaskModePath)))
        : '';
    const taskModeIndexRelativePath = taskModeArtifactRelativePath
        ? gateHelpers.normalizePath(path.join(path.dirname(taskModeArtifactRelativePath), 'reviews-index.json'))
        : '';
    const allowedBoundaryFiles = [
        ...(previousTaskMode.dirty_workspace_baseline?.changed_files || []),
        taskModeArtifactRelativePath,
        taskModeIndexRelativePath,
        ...getTaskManualValidationBoundaryFiles(resolvedTaskId, currentRemediationChangedFiles)
    ].filter(Boolean);
    const classificationConfig = getClassificationConfig(repoRoot);
    const scopeBoundary = assessReviewRemediationScopeBoundary(
        previousChangedFiles,
        currentRemediationChangedFiles,
        allowedBoundaryFiles,
        classificationConfig.test_trigger_regexes
    );
    let remediationFixClassification = classifyReviewRemediationFix(
        scopeBoundary,
        [],
        undefined,
        classificationConfig.test_trigger_regexes
    );
    let remediationImpactAnalysis: ReviewRemediationImpactAnalysis;
    const taskSummary = String(options.taskIntent || previousTaskMode.task_summary || '').trim();
    if (!taskSummary) {
        throw new Error('Task intent could not be resolved for review-cycle restart.');
    }

    try {
        const refreshedPreflightPath = resolveRecoveryPreflightPath(
            repoRoot,
            resolvedTaskId,
            options.preflightOutputPath || resolvedPreflightPath,
            'PreflightOutputPath'
        );
        const prePreflightRefreshPlan = getReviewCyclePrePreflightRefreshPlan(repoRoot, resolvedTaskId);
        try {
            remediationImpactAnalysis = resolveReviewRemediationImpactAnalysis(
                repoRoot,
                options,
                scopeBoundary.currentChangedFiles
            );
            remediationFixClassification = classifyReviewRemediationFix(
                scopeBoundary,
                [],
                remediationImpactAnalysis,
                classificationConfig.test_trigger_regexes
            );
        } catch (error: unknown) {
            const artifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
                schema_version: 1,
                task_id: resolvedTaskId,
                status: 'BLOCKED',
                reason: 'missing_or_incomplete_remediation_impact_analysis',
                previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                    ? gateHelpers.fileSha256(resolvedPreflightPath)
                    : null,
                detection_source: replayScope.detectionSource,
                impact_analysis: {
                    status: 'BLOCKED',
                    reason: error instanceof Error ? error.message : String(error),
                    required_topics: [...REMEDIATION_IMPACT_ANALYSIS_TOPICS],
                    affected_files: scopeBoundary.currentChangedFiles
                },
                remediation_fix_classification: remediationFixClassification,
                remediation_scope: {
                    status: scopeBoundary.status,
                    previous_changed_files: scopeBoundary.previousChangedFiles,
                    current_changed_files: scopeBoundary.currentChangedFiles,
                    expanded_files: scopeBoundary.expandedFiles,
                    expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                    allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
                },
                refresh_points: {
                    preflight: 'not_run_impact_analysis_blocked',
                    post_preflight_rule_pack: 'not_run_impact_analysis_blocked',
                    compile: 'not_run_impact_analysis_blocked',
                    review_contexts: 'not_run_impact_analysis_blocked'
                },
                reuse_boundaries: {
                    non_test_changes_must_stay_within_previous_preflight_scope: true,
                    test_only_expansion_allowed: true,
                    expanded_non_test_files_block_reuse: true
                }
            });
            throw new Error(
                `${error instanceof Error ? error.message : String(error)} ` +
                `Artifact: ${gateHelpers.normalizePath(artifactPath)}.`
            );
        }

        if (scopeBoundary.status === 'BLOCKED') {
            const artifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
                schema_version: 1,
                task_id: resolvedTaskId,
                status: 'BLOCKED',
                reason: 'failed_review_remediation_scope_expanded',
                previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                    ? gateHelpers.fileSha256(resolvedPreflightPath)
                    : null,
                detection_source: replayScope.detectionSource,
                impact_analysis: remediationImpactAnalysis,
                remediation_fix_classification: remediationFixClassification,
                remediation_scope: {
                    status: scopeBoundary.status,
                    previous_changed_files: scopeBoundary.previousChangedFiles,
                    current_changed_files: scopeBoundary.currentChangedFiles,
                    expanded_files: scopeBoundary.expandedFiles,
                    expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                    allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
                },
                refresh_points: {
                    preflight: 'not_run_scope_blocked',
                    post_preflight_rule_pack: 'not_run_scope_blocked',
                    compile: 'not_run_scope_blocked',
                    review_contexts: 'not_run_scope_blocked'
                },
                reuse_boundaries: {
                    non_test_changes_must_stay_within_previous_preflight_scope: true,
                    test_only_expansion_allowed: true,
                    expanded_non_test_files_block_reuse: true
                }
            });
            throw new Error(
                `restart-review-cycle blocked failed-review remediation because non-test files outside the failed review scope changed: ` +
                `${scopeBoundary.expandedNonTestFiles.join(', ')}. ` +
                `Artifact: ${gateHelpers.normalizePath(artifactPath)}. ` +
                'Refresh the normal preflight/classification path or split the expanded work into a separate task.'
            );
        }

        if (prePreflightRefreshPlan.rerunHandshakeDiagnostics) {
            ensureStepPassed('handshake-diagnostics', runHandshakeDiagnosticsCommand({
                repoRoot,
                taskId: resolvedTaskId,
                provider: previousTaskMode.provider || undefined,
                emitMetrics: options.emitMetrics
            }));
        }

        if (prePreflightRefreshPlan.rerunShellSmokePreflight) {
            ensureStepPassed('shell-smoke-preflight', runShellSmokePreflightCommand({
                repoRoot,
                taskId: resolvedTaskId,
                provider: previousTaskMode.provider || undefined,
                emitMetrics: options.emitMetrics
            }));
        }

        const classifyResult = runClassifyChangeCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath || undefined,
            outputPath: refreshedPreflightPath,
            taskIntent: taskSummary,
            changedFiles: resolveReviewRemediationClassifyChangedFiles(replayScope, scopeBoundary),
            useStaged: replayScope.useStaged,
            includeUntracked: replayScope.includeUntracked,
            emitMetrics: options.emitMetrics
        });
        const refreshedPreflight = getPreflightContext(refreshedPreflightPath, resolvedTaskId);
        const refreshedRequiredReviews = refreshedPreflight.preflight.required_reviews as Record<string, boolean>;
        const effectiveDepth = getEffectiveDepthFromPreflight(previousTaskMode, refreshedPreflight);
        const reviewExecutionPolicyMode = resolveReviewExecutionPolicyModeFromPreflight(refreshedPreflight.preflight);

        ensureStepPassed('load-rule-pack (POST_PREFLIGHT)', runLoadRulePackCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath || undefined,
            stage: 'POST_PREFLIGHT',
            preflightPath: refreshedPreflightPath,
            loadedRuleFiles: normalizeRuleFileList(refreshedRequiredReviews, effectiveDepth),
            emitMetrics: options.emitMetrics
        }));

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath || undefined,
            preflightPath: refreshedPreflightPath,
            commandsPath: options.commandsPath,
            outputFiltersPath: options.outputFiltersPath,
            failTailLines: options.failTailLines,
            emitMetrics: options.emitMetrics
        } as CompileGateCommandOptions);
        ensureStepPassed('compile-gate', compileResult);

        const requiredReviewBatches = getReviewExecutionPreparationBatches(
            refreshedRequiredReviews,
            reviewExecutionPolicyMode
        );
        const requiredReviewTypes = requiredReviewBatches.flat();
        remediationFixClassification = classifyReviewRemediationFix(
            scopeBoundary,
            requiredReviewTypes,
            remediationImpactAnalysis,
            classificationConfig.test_trigger_regexes,
            refreshedPreflight.preflight
        );
        const sharedTokenEconomyConfigPath = resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'token-economy.json'));
        const sharedTokenEconomyConfigData: TokenEconomyConfig | null = (
            fs.existsSync(sharedTokenEconomyConfigPath)
            && fs.statSync(sharedTokenEconomyConfigPath).isFile()
        )
            ? JSON.parse(fs.readFileSync(sharedTokenEconomyConfigPath, 'utf8')) as TokenEconomyConfig
            : null;
        const sharedRuleContextSectionsCache = new Map();
        const sharedRuleFileContentCache = new Map<string, string>();
        const sharedRuntimeReviewerIdentity = resolveRuntimeReviewerIdentity({
            repoRoot,
            taskId: resolvedTaskId,
            taskModePath: resolvedTaskModePath,
            taskModeEvidence: previousTaskMode,
            allowLegacyFallback: true
        });
        const preparedResults: BuildReviewContextCommandResult[] = [];
        const reusedReviewTypes: string[] = [];
        const launchRequiredReviewTypes: string[] = [];
        let pendingReviewTypes: string[] = [];
        let pendingReason: string | null = null;
        const invalidatedReviewTypes = new Set(remediationFixClassification.invalidated_review_types);

        for (let batchIndex = 0; batchIndex < requiredReviewBatches.length; batchIndex += 1) {
            const reviewBatch = requiredReviewBatches[batchIndex];
            const batchTimelineSummary = readTimelineEventsSummary(
                gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`))
            );
            const batchResults = await Promise.all(reviewBatch.map(async (reviewType) => {
                try {
                    const reviewReuseBlockedReason = invalidatedReviewTypes.has(reviewType)
                        ? `review reuse blocked by remediation classification '${remediationFixClassification.category}' for invalidated review type '${reviewType}'`
                        : '';
                    const remediationPreservedScopeMismatchReason = reviewReuseBlockedReason
                        ? ''
                        : `remediation classification '${remediationFixClassification.category}' preserved review type '${reviewType}'`;
                    const scopedDiffExpected = buildReviewContextPreflightDiffExpectations(
                        refreshedPreflight.preflight,
                        reviewType
                    ).expectedScopedDiff;
                    const scopedDiffMetadataPath = scopedDiffExpected
                        ? resolveScopedDiffMetadataPath('', refreshedPreflightPath, reviewType, repoRoot)
                        : '';
                    if (scopedDiffExpected) {
                        buildScopedDiff({
                            reviewType,
                            preflightPath: refreshedPreflightPath,
                            pathsConfigPath: resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'paths.json')),
                            outputPath: resolveScopedDiffOutputPath('', refreshedPreflightPath, reviewType, repoRoot),
                            metadataPath: scopedDiffMetadataPath,
                            repoRoot,
                            useStaged: replayScope.useStaged
                        });
                    }
                    const prepared = await runBuildReviewContextCommand({
                        repoRoot,
                        reviewType,
                        depth: String(effectiveDepth),
                        preflightPath: refreshedPreflightPath,
                        preflightPayload: refreshedPreflight.preflight,
                        taskModePath: String(previousTaskMode.evidence_path || '').trim() || undefined,
                        taskModeEvidence: previousTaskMode,
                        runtimeReviewerIdentity: sharedRuntimeReviewerIdentity,
                        tokenEconomyConfigPath: sharedTokenEconomyConfigPath,
                        tokenEconomyConfigData: sharedTokenEconomyConfigData,
                        scopedDiffMetadataPath,
                        timelineEventsSummary: batchTimelineSummary,
                        reviewReuseBlockedReason,
                        remediationPreservedScopeMismatchReason,
                        ruleContextSectionsCache: sharedRuleContextSectionsCache,
                        ruleFileContentCache: sharedRuleFileContentCache
                    });
                    return {
                        reviewType,
                        prepared,
                        dependencyBlockReason: null,
                        error: null
                    };
                } catch (error: unknown) {
                    return {
                        reviewType,
                        prepared: null,
                        dependencyBlockReason: getDependencyBlockReason(error, reviewType),
                        error
                    };
                }
            }));

            const unexpectedFailure = batchResults.find((result) => result.error && !result.dependencyBlockReason);
            if (unexpectedFailure) {
                throw unexpectedFailure.error;
            }

            for (const result of batchResults) {
                if (!result.prepared) {
                    continue;
                }
                preparedResults.push(result.prepared);
                if (result.prepared.reusedReviewEvidence) {
                    reusedReviewTypes.push(result.reviewType);
                } else {
                    launchRequiredReviewTypes.push(result.reviewType);
                }
            }

            const dependencyBlockedResult = batchResults.find((result) => result.dependencyBlockReason);
            if (dependencyBlockedResult) {
                pendingReviewTypes = requiredReviewTypes.slice(requiredReviewTypes.indexOf(dependencyBlockedResult.reviewType));
                pendingReason = dependencyBlockedResult.dependencyBlockReason;
                break;
            }
        }

        const nextStep = pendingReviewTypes.length > 0
            ? 'Launch and record the prepared upstream reviews first, then rerun restart-review-cycle to materialize the remaining downstream review contexts.'
            : launchRequiredReviewTypes.length > 0
                ? 'Launch and record the prepared review types in dependency-safe order, then rerun required-reviews-check, doc-impact-gate, and completion-gate.'
                : 'All required review evidence is already current-cycle. Rerun required-reviews-check, doc-impact-gate, and completion-gate.';
        const remediationArtifactPath = writeReviewRemediationCycleArtifact(repoRoot, resolvedTaskId, {
            schema_version: 1,
            task_id: resolvedTaskId,
            status: 'PASSED',
            previous_preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
            previous_preflight_sha256: fs.existsSync(resolvedPreflightPath)
                ? gateHelpers.fileSha256(resolvedPreflightPath)
                : null,
            refreshed_preflight_path: gateHelpers.normalizePath(refreshedPreflightPath),
            refreshed_preflight_sha256: fs.existsSync(refreshedPreflightPath)
                ? gateHelpers.fileSha256(refreshedPreflightPath)
                : null,
            detection_source: replayScope.detectionSource,
            impact_analysis: remediationImpactAnalysis,
            remediation_fix_classification: remediationFixClassification,
            remediation_scope: {
                status: scopeBoundary.status,
                previous_changed_files: scopeBoundary.previousChangedFiles,
                current_changed_files: scopeBoundary.currentChangedFiles,
                expanded_files: scopeBoundary.expandedFiles,
                expanded_non_test_files: scopeBoundary.expandedNonTestFiles,
                allowed_test_only_expansion_files: scopeBoundary.allowedTestOnlyExpansionFiles
            },
            refresh_points: {
                preflight: 'refreshed',
                post_preflight_rule_pack: 'reloaded',
                compile: 'rerun',
                review_contexts: pendingReviewTypes.length > 0 ? 'partially_prepared_dependency_blocked' : 'prepared_or_reused'
            },
            review_reuse: {
                review_execution_policy: reviewExecutionPolicyMode,
                prepared_review_types: preparedResults.map((result) => result.reviewType),
                launch_required_review_types: launchRequiredReviewTypes,
                reused_review_types: reusedReviewTypes,
                pending_review_types: pendingReviewTypes,
                pending_reason: pendingReason
            },
            reuse_boundaries: {
                non_test_changes_must_stay_within_previous_preflight_scope: true,
                test_only_expansion_allowed: true,
                expanded_non_test_files_block_reuse: true
            }
        });
        const reviewContextsRefreshStatus = pendingReviewTypes.length > 0
            ? 'partially_prepared_dependency_blocked'
            : 'prepared_or_reused';
        appendRestartCompletedEvidence({
            repoRoot,
            taskId: resolvedTaskId,
            eventType: 'REVIEW_CYCLE_RESTARTED',
            artifactSuffix: '-review-cycle-restart.json',
            message: 'Review remediation cycle restarted after compile gate pass.',
            taskModePath: resolvedTaskModePath,
            preflightPath: refreshedPreflightPath,
            compileEvidencePath: resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`),
            detectionSource: replayScope.detectionSource,
            plannedChangedFilesCount: previousChangedFiles.length,
            detectedChangedFilesCount: scopeBoundary.currentChangedFiles.length,
            elapsedMs: Date.now() - startedAt,
            restartReason: 'failed_review_remediation_cycle',
            nextStepSummary: nextStep,
            extraDetails: {
                remediation_artifact_path: gateHelpers.normalizePath(remediationArtifactPath),
                remediation_artifact_sha256: requireArtifactSha256(remediationArtifactPath, 'review-remediation-cycle'),
                impact_analysis_source: remediationImpactAnalysis.source,
                affected_files_count: scopeBoundary.currentChangedFiles.length,
                remediation_category: remediationFixClassification.category,
                invalidated_review_types: remediationFixClassification.invalidated_review_types,
                preserved_review_types: remediationFixClassification.preserved_review_types,
                review_contexts_refresh_status: reviewContextsRefreshStatus,
                review_execution_policy_mode: reviewExecutionPolicyMode,
                prepared_review_types: preparedResults.map((result) => result.reviewType),
                launch_required_review_types: launchRequiredReviewTypes,
                reused_review_types: reusedReviewTypes,
                pending_review_types: pendingReviewTypes,
                pending_reason: pendingReason
            }
        });

        return {
            outputLines: buildReviewCycleRestartedOutput({
                taskId: resolvedTaskId,
                preflightPath: refreshedPreflightPath,
                remediationArtifactPath,
                detectionSource: replayScope.detectionSource,
                affectedFilesCount: scopeBoundary.currentChangedFiles.length,
                impactAnalysisSource: remediationImpactAnalysis.source,
                remediationCategory: remediationFixClassification.category,
                invalidatedReviewTypes: remediationFixClassification.invalidated_review_types,
                preservedReviewTypes: remediationFixClassification.preserved_review_types,
                scopeBoundaryStatus: scopeBoundary.status,
                previousFilesCount: scopeBoundary.previousChangedFiles.length,
                currentFilesCount: scopeBoundary.currentChangedFiles.length,
                expandedNonTestFiles: scopeBoundary.expandedNonTestFiles,
                reviewContextsRefreshStatus,
                effectiveDepth,
                reviewExecutionPolicyMode,
                preparedResults,
                launchRequiredReviewTypes,
                reusedReviewTypes,
                pendingReviewTypes,
                pendingReason,
                nextStep,
                preflightSummary: classifyResult.outputText
            }),
            exitCode: 0
        };
    } catch (error: unknown) {
        return {
            outputLines: [
                'REVIEW_CYCLE_RESTART_FAILED',
                `TaskId: ${resolvedTaskId}`,
                error instanceof Error ? error.message : String(error)
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
}
