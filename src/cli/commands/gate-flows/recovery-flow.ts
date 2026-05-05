import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../exit-codes';
import {
    getReviewExecutionPreparationBatches,
    resolveReviewExecutionPolicyModeFromPreflight
} from '../../../core/review-execution-policy';
import { assertValidTaskId } from '../../../gate-runtime/task-events';
import { selectRulePackFiles } from '../../../gates/build-review-context';
import { collectOrderedTimelineEvents, findLatestTimelineEvent } from '../../../gates/completion-evidence';
import { getPreflightContext } from '../../../gates/compile-gate';
import {
    getLatestPrePreflightCycleAnchor,
    isTaskEntryRulePackLoadedEvent
} from '../../../gates/pre-preflight-cycle-anchor';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../../../gates/task-mode';
import * as gateHelpers from '../../../gates/helpers';
import { expandValueList, parseBooleanOption } from '../gates-parser';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    type CompileGateCommandOptions
} from './compile-flow';
import {
    runBuildReviewContextCommand,
    readTimelineEventsSummary,
    type BuildReviewContextCommandResult
} from '../gate-build-handlers';
import {
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runShellSmokePreflightCommand
} from './task-mode-flow';
import { resolveGateExecutionPath } from '../../../gates/isolation-sandbox';
import type { TokenEconomyConfig } from '../../../gates/build-review-context';
import { resolveRuntimeReviewerIdentity } from '../../../gates/reviewer-routing';

const TASK_ENTRY_RULE_FILES = Object.freeze([
    '00-core.md',
    '15-project-memory.md',
    '40-commands.md',
    '80-task-workflow.md',
    '90-skill-catalog.md'
]);

const REVIEW_CYCLE_BOUNDARY_EVENTS = new Set([
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_PASSED'
]);

export interface RestartCoherentCycleCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    taskModePath?: string;
    preflightPath?: string;
    preflightOutputPath?: string;
    changedFiles?: unknown;
    includeUntracked?: unknown;
    useStaged?: boolean;
    taskIntent?: unknown;
    commandsPath?: string;
    outputFiltersPath?: string;
    failTailLines?: unknown;
    emitMetrics?: unknown;
}

export interface RestartReviewCycleCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    taskModePath?: string;
    preflightPath?: string;
    preflightOutputPath?: string;
    changedFiles?: unknown;
    includeUntracked?: unknown;
    useStaged?: boolean;
    taskIntent?: unknown;
    commandsPath?: string;
    outputFiltersPath?: string;
    failTailLines?: unknown;
    emitMetrics?: unknown;
}

interface ResolvedReplayScope {
    plannedChangedFiles: string[];
    changedFiles?: string[];
    useStaged?: boolean;
    includeUntracked?: boolean;
    detectionSource: string;
}

function normalizeChangedFiles(values: readonly unknown[]): string[] {
    return [...new Set(values.map((entry) => String(entry || '').trim()).filter(Boolean))].sort();
}

function normalizeRuleFileList(requiredReviews: Record<string, boolean>, effectiveDepth: number): string[] {
    const fileNames = new Set<string>(TASK_ENTRY_RULE_FILES);
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (!required) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }
    return [...fileNames].sort();
}

function resolveReplayScope(
    options: RestartCoherentCycleCommandOptions,
    previousPreflight: ReturnType<typeof getPreflightContext>
): ResolvedReplayScope {
    const explicitChangedFilesProvided = options.changedFiles !== undefined;
    const explicitChangedFiles = normalizeChangedFiles(expandValueList(options.changedFiles || [], { splitDelimiters: true }));
    const previousChangedFiles = normalizeChangedFiles(previousPreflight.changed_files as unknown[]);

    if (explicitChangedFilesProvided) {
        return {
            plannedChangedFiles: explicitChangedFiles,
            changedFiles: explicitChangedFiles,
            detectionSource: 'explicit_changed_files'
        };
    }

    if (options.useStaged === true) {
        const includeUntracked = parseBooleanOption(options.includeUntracked, previousPreflight.include_untracked);
        return {
            plannedChangedFiles: previousChangedFiles,
            useStaged: true,
            includeUntracked,
            detectionSource: includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only'
        };
    }

    switch (previousPreflight.detection_source) {
        case 'explicit_changed_files':
            return {
                plannedChangedFiles: previousChangedFiles,
                changedFiles: previousChangedFiles,
                detectionSource: 'explicit_changed_files'
            };
        case 'git_staged_only':
            return {
                plannedChangedFiles: previousChangedFiles,
                useStaged: true,
                includeUntracked: false,
                detectionSource: 'git_staged_only'
            };
        case 'git_staged_plus_untracked':
            return {
                plannedChangedFiles: previousChangedFiles,
                useStaged: true,
                includeUntracked: true,
                detectionSource: 'git_staged_plus_untracked'
            };
        default:
            return {
                plannedChangedFiles: previousChangedFiles,
                changedFiles: previousChangedFiles,
                detectionSource: 'explicit_changed_files'
            };
    }
}

function resolveReviewCycleReplayScope(
    options: RestartReviewCycleCommandOptions,
    previousPreflight: ReturnType<typeof getPreflightContext>,
    previousTaskMode: ReturnType<typeof getTaskModeEvidence>
): ResolvedReplayScope {
    const explicitChangedFilesProvided = options.changedFiles !== undefined;
    const explicitChangedFiles = normalizeChangedFiles(expandValueList(options.changedFiles || [], { splitDelimiters: true }));
    const previousChangedFiles = normalizeChangedFiles(previousPreflight.changed_files as unknown[]);
    const taskStartedDirty = !!previousTaskMode.dirty_workspace_baseline?.changed_files.length;

    if (explicitChangedFilesProvided) {
        return {
            plannedChangedFiles: explicitChangedFiles,
            changedFiles: explicitChangedFiles,
            detectionSource: 'explicit_changed_files'
        };
    }

    if (options.useStaged === true) {
        const includeUntracked = parseBooleanOption(options.includeUntracked, previousPreflight.include_untracked);
        return {
            plannedChangedFiles: previousChangedFiles,
            useStaged: true,
            includeUntracked,
            detectionSource: includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only'
        };
    }

    switch (previousPreflight.detection_source) {
        case 'git_staged_only':
            return {
                plannedChangedFiles: previousChangedFiles,
                useStaged: true,
                includeUntracked: false,
                detectionSource: 'git_staged_only'
            };
        case 'git_staged_plus_untracked':
            return {
                plannedChangedFiles: previousChangedFiles,
                useStaged: true,
                includeUntracked: true,
                detectionSource: 'git_staged_plus_untracked'
            };
        default:
            return {
                plannedChangedFiles: previousChangedFiles,
                changedFiles: taskStartedDirty ? previousChangedFiles : undefined,
                detectionSource: taskStartedDirty ? 'explicit_changed_files' : 'git_auto_current_workspace'
            };
    }
}

function getEffectiveDepthFromPreflight(
    previousTaskMode: ReturnType<typeof getTaskModeEvidence>,
    refreshedPreflight: ReturnType<typeof getPreflightContext>
): number {
    const riskAwareDepth = refreshedPreflight.preflight?.risk_aware_depth;
    if (
        riskAwareDepth
        && typeof riskAwareDepth === 'object'
        && !Array.isArray(riskAwareDepth)
        && typeof (riskAwareDepth as Record<string, unknown>).effective_depth === 'number'
    ) {
        return (riskAwareDepth as Record<string, number>).effective_depth;
    }
    return previousTaskMode.effective_depth || previousTaskMode.requested_depth || 2;
}

function formatReviewTypeList(reviewTypes: readonly string[]): string {
    return reviewTypes.length > 0 ? reviewTypes.join(', ') : 'none';
}

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

function getReviewCyclePrePreflightRefreshPlan(
    repoRoot: string,
    taskId: string
): { rerunHandshakeDiagnostics: boolean; rerunShellSmokePreflight: boolean } {
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            rerunHandshakeDiagnostics: true,
            rerunShellSmokePreflight: true
        };
    }

    const latestTaskModeEntered = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (latestTaskModeEntered) {
        const latestTaskEntryRulePack = findLatestTimelineEvent(
            events,
            (entry) => entry.sequence > latestTaskModeEntered.sequence && isTaskEntryRulePackLoadedEvent(entry)
        );
        if (!latestTaskEntryRulePack) {
            throw new Error(
                `restart-review-cycle detected TASK_MODE_ENTERED without matching RULE_PACK_LOADED for TASK_ENTRY ` +
                `inside the current task-mode cycle in '${gateHelpers.normalizePath(timelinePath)}'. ` +
                'Run restart-coherent-cycle to rebuild the cycle from task entry before rerunning review preparation.'
            );
        }
    }

    const latestCycleAnchor = getLatestPrePreflightCycleAnchor(events);
    const lowerBoundExclusive = latestCycleAnchor?.sequence ?? Number.NEGATIVE_INFINITY;
    const latestCycleBoundary = findLatestTimelineEvent(
        events,
        (entry) => entry.sequence > lowerBoundExclusive && REVIEW_CYCLE_BOUNDARY_EVENTS.has(entry.event_type)
    );
    if (latestCycleBoundary) {
        throw new Error(
            `restart-review-cycle cannot continue after the current task-mode cycle already reached '${latestCycleBoundary.event_type}' ` +
            `in '${gateHelpers.normalizePath(timelinePath)}'. Run restart-coherent-cycle to begin a fresh coherent cycle ` +
            'from task entry before rebuilding review contexts.'
        );
    }

    const latestHandshake = findLatestTimelineEvent(
        events,
        (entry) => entry.sequence > lowerBoundExclusive && entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
    );
    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.sequence > lowerBoundExclusive && entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
    );

    if (!latestHandshake && !latestShellSmoke) {
        return {
            rerunHandshakeDiagnostics: true,
            rerunShellSmokePreflight: true
        };
    }

    if (!latestHandshake && latestShellSmoke) {
        throw new Error(
            `restart-review-cycle detected SHELL_SMOKE_PREFLIGHT_RECORDED without matching HANDSHAKE_DIAGNOSTICS_RECORDED ` +
            `inside the current task-mode cycle in '${gateHelpers.normalizePath(timelinePath)}'. ` +
            'Run restart-coherent-cycle to rebuild the cycle from task entry.'
        );
    }

    if (latestHandshake && (!latestShellSmoke || latestShellSmoke.sequence < latestHandshake.sequence)) {
        return {
            rerunHandshakeDiagnostics: false,
            rerunShellSmokePreflight: true
        };
    }

    return {
        rerunHandshakeDiagnostics: false,
        rerunShellSmokePreflight: false
    };
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
            outputLines: [
                'COHERENT_CYCLE_RESTARTED',
                `TaskId: ${resolvedTaskId}`,
                `TaskModePath: ${gateHelpers.normalizePath(resolvedTaskModePath)}`,
                `PreflightPath: ${gateHelpers.normalizePath(refreshedPreflightPath)}`,
                `DetectionSource: ${replayScope.detectionSource}`,
                `PlannedChangedFilesCount: ${replayScope.plannedChangedFiles.length}`,
                `ChangedFilesCount: ${refreshedPreflight.changed_files_count}`,
                'NextStep: materialize review artifacts for the new compile cycle, then rerun required-reviews-check, doc-impact-gate, and completion-gate.',
                `PreflightSummary: ${classifyResult.outputText.trim().replace(/\s+/g, ' ')}`
            ],
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
    const taskSummary = String(options.taskIntent || previousTaskMode.task_summary || '').trim();
    if (!taskSummary) {
        throw new Error('Task intent could not be resolved for review-cycle restart.');
    }

    try {
        const refreshedPreflightPath = String(options.preflightOutputPath || resolvedPreflightPath).trim() || resolvedPreflightPath;
        const prePreflightRefreshPlan = getReviewCyclePrePreflightRefreshPlan(repoRoot, resolvedTaskId);

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
            changedFiles: replayScope.changedFiles,
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

        for (let batchIndex = 0; batchIndex < requiredReviewBatches.length; batchIndex += 1) {
            const reviewBatch = requiredReviewBatches[batchIndex];
            const batchTimelineSummary = readTimelineEventsSummary(
                gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`))
            );
            const batchResults = await Promise.all(reviewBatch.map(async (reviewType) => {
                try {
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
                        timelineEventsSummary: batchTimelineSummary,
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

        return {
            outputLines: [
                'REVIEW_CYCLE_RESTARTED',
                `TaskId: ${resolvedTaskId}`,
                `PreflightPath: ${gateHelpers.normalizePath(refreshedPreflightPath)}`,
                `DetectionSource: ${replayScope.detectionSource}`,
                `EffectiveDepth: ${effectiveDepth}`,
                `ReviewExecutionPolicy: ${reviewExecutionPolicyMode}`,
                `PreparedReviewTypes: ${formatReviewTypeList(preparedResults.map((result) => result.reviewType))}`,
                `LaunchRequiredReviewTypes: ${formatReviewTypeList(launchRequiredReviewTypes)}`,
                `ReusedReviewTypes: ${formatReviewTypeList(reusedReviewTypes)}`,
                ...preparedResults.flatMap((result) => ([
                    `PreparedReviewContext[${result.reviewType}]: ${gateHelpers.normalizePath(result.outputPath)}`,
                    `RuleContextArtifact[${result.reviewType}]: ${gateHelpers.normalizePath(result.ruleContextArtifactPath)}`
                ])),
                ...(pendingReviewTypes.length > 0
                    ? [
                        `PendingReviewTypes: ${formatReviewTypeList(pendingReviewTypes)}`,
                        `PendingReason: ${pendingReason}`
                    ]
                    : []),
                `NextStep: ${nextStep}`,
                `PreflightSummary: ${classifyResult.outputText.trim().replace(/\s+/g, ' ')}`
            ],
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
