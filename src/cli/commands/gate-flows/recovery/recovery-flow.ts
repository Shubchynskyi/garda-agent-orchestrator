import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import {
    getReviewExecutionPreparationBatches,
    resolveReviewExecutionPolicyModeFromPreflight
} from '../../../../core/review-execution-policy';
import { assertValidTaskId } from '../../../../gate-runtime/task-events';
import { type TokenEconomyConfig } from '../../../../gates/review-context/review-context-token-economy';
import { getClassificationConfig } from '../../../../gates/preflight/classify-change';
import { buildScopedDiff, resolveMetadataPath as resolveScopedDiffMetadataPath, resolveOutputPath as resolveScopedDiffOutputPath } from '../../../../gates/preflight/build-scoped-diff';
import { getPreflightContext } from '../../../../gates/compile/compile-gate';
import { buildReviewContextPreflightDiffExpectations } from '../../../../gates/review-context/review-context-contract';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../../../../gates/task-mode/task-mode';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    type CompileGateCommandOptions
} from '../compile/compile-flow';
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

function getTaskManualValidationBoundaryFiles(taskId: string, currentChangedFiles: readonly string[]): string[] {
    const taskManualValidationPath = gateHelpers.normalizePath(
        path.join('garda-agent-orchestrator', 'runtime', 'manual-validation', taskId)
    );
    const deployedTaskManualValidationPath = gateHelpers.normalizePath(
        path.join('runtime', 'manual-validation', taskId)
    );
    return normalizeChangedFiles(currentChangedFiles).filter((entry) => (
        entry === taskManualValidationPath
        || entry.startsWith(`${taskManualValidationPath}/`)
        || entry === deployedTaskManualValidationPath
        || entry.startsWith(`${deployedTaskManualValidationPath}/`)
    ));
}

export async function runRestartCoherentCycleCommand(
    options: RestartCoherentCycleCommandOptions
): Promise<{ outputLines: string[]; exitCode: number }> {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const resolvedTaskId = assertValidTaskId(String(options.taskId || '').trim());
    const previousTaskMode = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
    const taskModeViolations = getTaskModeEvidenceViolations(previousTaskMode);
    if (taskModeViolations.length > 0) {
        throw new Error(taskModeViolations.join(' '));
    }

    const resolvedTaskModePath = String(options.taskModePath || previousTaskMode.evidence_path || '').trim();
    const resolvedPreflightPath = path.resolve(String(
        options.preflightPath
        || gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${resolvedTaskId}-preflight.json`))
    ));
    const previousPreflight = getPreflightContext(resolvedPreflightPath, resolvedTaskId);
    const replayScope = resolveReplayScope(options, previousPreflight);
    const taskSummary = String(options.taskIntent || previousTaskMode.task_summary || '').trim();
    if (!taskSummary) {
        throw new Error('Task intent could not be resolved for coherent-cycle restart.');
    }

    try {
        if (previousTaskMode.start_banner) {
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
                provider: previousTaskMode.provider || undefined,
                routedTo: previousTaskMode.routed_to || undefined,
                planPath: previousTaskMode.plan?.plan_path || undefined,
                emitMetrics: options.emitMetrics
            }));
        }

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

        const refreshedPreflightPath = String(options.preflightOutputPath || resolvedPreflightPath).trim() || resolvedPreflightPath;
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
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const resolvedTaskId = assertValidTaskId(String(options.taskId || '').trim());
    const previousTaskMode = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
    const taskModeViolations = getTaskModeEvidenceViolations(previousTaskMode);
    if (taskModeViolations.length > 0) {
        throw new Error(taskModeViolations.join(' '));
    }

    const resolvedTaskModePath = String(options.taskModePath || previousTaskMode.evidence_path || '').trim();
    const resolvedPreflightPath = path.resolve(String(
        options.preflightPath
        || gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${resolvedTaskId}-preflight.json`))
    ));
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
        const refreshedPreflightPath = String(options.preflightOutputPath || resolvedPreflightPath).trim() || resolvedPreflightPath;
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
                reviewContextsRefreshStatus: pendingReviewTypes.length > 0
                    ? 'partially_prepared_dependency_blocked'
                    : 'prepared_or_reused',
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
