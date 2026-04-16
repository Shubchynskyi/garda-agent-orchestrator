import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../exit-codes';
import { assertValidTaskId } from '../../../gate-runtime/task-events';
import { selectRulePackFiles } from '../../../gates/build-review-context';
import { getPreflightContext } from '../../../gates/compile-gate';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from '../../../gates/task-mode';
import * as gateHelpers from '../../../gates/helpers';
import { expandValueList, parseBooleanOption } from '../gates-parser';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    type CompileGateCommandOptions
} from './compile-flow';
import {
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runShellSmokePreflightCommand
} from './task-mode-flow';

const TASK_ENTRY_RULE_FILES = Object.freeze([
    '00-core.md',
    '40-commands.md',
    '80-task-workflow.md',
    '90-skill-catalog.md'
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

function ensureStepPassed(stepName: string, result: { outputLines: string[]; exitCode: number }): void {
    if (result.exitCode !== 0) {
        throw new Error(`${stepName} failed during coherent-cycle restart.\n${result.outputLines.join('\n')}`.trim());
    }
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
        ensureStepPassed('enter-task-mode', runEnterTaskModeCommand({
            repoRoot,
            taskId: resolvedTaskId,
            artifactPath: resolvedTaskModePath,
            entryMode: previousTaskMode.entry_mode || 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: previousTaskMode.requested_depth || 2,
            effectiveDepth: previousTaskMode.effective_depth || previousTaskMode.requested_depth || 2,
            taskSummary,
            plannedChangedFiles: replayScope.plannedChangedFiles,
            orchestratorWork: previousTaskMode.orchestrator_work === true,
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

        const refreshedPreflightPath = String(options.preflightOutputPath || resolvedPreflightPath).trim() || resolvedPreflightPath;
        const classifyResult = runClassifyChangeCommand({
            repoRoot,
            taskId: resolvedTaskId,
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
