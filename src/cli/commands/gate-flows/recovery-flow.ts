import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../exit-codes';
import {
    getReviewExecutionPreparationBatches,
    resolveReviewExecutionPolicyModeFromPreflight
} from '../../../core/review-execution-policy';
import { matchAnyRegex } from '../../../gate-runtime/text-utils';
import { writeReviewArtifactJson } from '../../../gate-runtime/review-artifacts';
import { assertValidTaskId } from '../../../gate-runtime/task-events';
import { selectRulePackFiles } from '../../../gates/build-review-context';
import { getClassificationConfig } from '../../../gates/classify-change';
import { collectOrderedTimelineEvents, findLatestTimelineEvent } from '../../../gates/completion-evidence';
import { getPreflightContext, getWorkspaceSnapshot } from '../../../gates/compile-gate';
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
    impactAnalysis?: unknown;
    impactAnalysisPath?: string;
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

interface ReviewRemediationScopeBoundary {
    status: 'OK' | 'BLOCKED';
    previousChangedFiles: string[];
    currentChangedFiles: string[];
    expandedFiles: string[];
    expandedNonTestFiles: string[];
    allowedTestOnlyExpansionFiles: string[];
}

interface ReviewRemediationImpactAnalysis {
    status: 'RECORDED';
    source: 'inline' | 'file';
    summary: string;
    required_topics: string[];
    affected_files: string[];
}

const REMEDIATION_IMPACT_ANALYSIS_MIN_CHARS = 120;
const REMEDIATION_IMPACT_ANALYSIS_TOPICS = Object.freeze([
    'reviewer finding',
    'intended fix',
    'affected files and contracts',
    'api/runtime/artifact/test impact',
    'possible side effects',
    'required targeted checks',
    'scope or review-type changes',
    'related blocker or follow-up decision'
]);
const REMEDIATION_IMPACT_ANALYSIS_PLACEHOLDERS = Object.freeze([
    '<replace with main-agent remediation impact analysis>',
    '<analysis>',
    '<reviewer finding; intended fix',
    'reviewer finding; intended fix; affected files/contracts'
]);
const REMEDIATION_IMPACT_ANALYSIS_TOPIC_CHECKS = Object.freeze([
    { topic: 'reviewer finding', pattern: /\b(reviewer\s+finding|finding|reviewer)\b/iu },
    { topic: 'intended fix', pattern: /\b(intended\s+fix|fix)\b/iu },
    { topic: 'affected files and contracts', pattern: /\b(affected\s+files?|affected\s+contracts?|contracts?)\b/iu },
    { topic: 'api/runtime/artifact/test impact', pattern: /\b(api|runtime|artifact|test)\s+impact\b|\bimpact\b/iu },
    { topic: 'possible side effects', pattern: /\b(possible\s+side\s+effects?|side\s+effects?|risk)\b/iu },
    { topic: 'required targeted checks', pattern: /\b(required\s+targeted\s+checks?|targeted\s+checks?|checks?|validation)\b/iu },
    { topic: 'scope or review-type changes', pattern: /\b(scope|review[-\s]?type|review\s+impact)\b/iu },
    { topic: 'related blocker or follow-up decision', pattern: /\b(related\s+blocker|follow[-\s]?up|separate\s+task|in[-\s]?scope)\b/iu }
]);
const REMEDIATION_IMPACT_ANALYSIS_DETAIL_MIN_CHARS = 8;
const REMEDIATION_IMPACT_ANALYSIS_FILE_MAX_BYTES = 64 * 1024;

function normalizeChangedFiles(values: readonly unknown[]): string[] {
    return [...new Set(values.map((entry) => gateHelpers.normalizePath(String(entry || '').trim())).filter(Boolean))].sort();
}

function normalizeImpactAnalysisText(value: unknown): string {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        return Object.entries(record)
            .filter(([, entryValue]) => entryValue !== null && entryValue !== undefined && String(entryValue).trim())
            .map(([key, entryValue]) => `${key}: ${Array.isArray(entryValue) ? entryValue.join(', ') : String(entryValue).trim()}`)
            .join('; ');
    }
    return String(value || '').trim();
}

function isPathInsideDirectory(candidatePath: string, rootPath: string): boolean {
    const relativePath = path.relative(rootPath, candidatePath);
    return relativePath === '' || Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function readImpactAnalysisPath(
    repoRoot: string,
    impactAnalysisPath: string
): { summary: string; source: 'file' } {
    const resolvedRepoRoot = fs.realpathSync.native(path.resolve(repoRoot));
    const candidatePath = path.isAbsolute(impactAnalysisPath)
        ? path.resolve(impactAnalysisPath)
        : path.resolve(resolvedRepoRoot, impactAnalysisPath);
    if (!isPathInsideDirectory(candidatePath, resolvedRepoRoot)) {
        throw new Error(
            'Remediation impact analysis file must stay inside the repository root: '
            + gateHelpers.normalizePath(candidatePath)
        );
    }
    const resolvedPath = candidatePath;
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Remediation impact analysis file does not exist: ${gateHelpers.normalizePath(resolvedPath)}`);
    }
    const realImpactPath = fs.realpathSync.native(resolvedPath);
    if (!isPathInsideDirectory(realImpactPath, resolvedRepoRoot)) {
        throw new Error(
            'Remediation impact analysis file must stay inside the repository root: '
            + gateHelpers.normalizePath(realImpactPath)
        );
    }
    const stat = fs.statSync(realImpactPath);
    if (!stat.isFile()) {
        throw new Error(`Remediation impact analysis file does not exist: ${gateHelpers.normalizePath(resolvedPath)}`);
    }
    if (stat.size > REMEDIATION_IMPACT_ANALYSIS_FILE_MAX_BYTES) {
        throw new Error(
            `Remediation impact analysis file must be <= ${REMEDIATION_IMPACT_ANALYSIS_FILE_MAX_BYTES} bytes: `
            + gateHelpers.normalizePath(realImpactPath)
        );
    }
    const rawContent = fs.readFileSync(realImpactPath, 'utf8').trim();
    if (!rawContent) {
        return { summary: '', source: 'file' };
    }
    try {
        return {
            summary: normalizeImpactAnalysisText(JSON.parse(rawContent) as unknown),
            source: 'file'
        };
    } catch {
        return {
            summary: rawContent,
            source: 'file'
        };
    }
}

function getImpactAnalysisClauses(summary: string): string[] {
    return summary
        .split(/[\n;]+/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function stripTopicLikeText(value: string, topic: string): string {
    return value
        .replace(new RegExp(topic.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'), '')
        .replace(/\b(reviewer\s+finding|finding|reviewer|intended\s+fix|fix|affected\s+files?|affected\s+contracts?|contracts?|api|runtime|artifact|test|impact|possible\s+side\s+effects?|side\s+effects?|risk|required\s+targeted\s+checks?|targeted\s+checks?|checks?|validation|scope|review[-\s]?type|review\s+impact|related\s+blocker|follow[-\s]?up|separate\s+task|in[-\s]?scope|decision)\b/giu, '')
        .replace(/[:\-()[\]{}<>"'`.,/\\|_]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function validateReviewRemediationImpactAnalysis(
    summary: string,
    affectedFiles: readonly string[]
): string[] {
    const lowerSummary = summary.toLocaleLowerCase();
    const violations: string[] = [];
    if (summary.length < REMEDIATION_IMPACT_ANALYSIS_MIN_CHARS) {
        violations.push(`analysis must be at least ${REMEDIATION_IMPACT_ANALYSIS_MIN_CHARS} characters`);
    }
    if (REMEDIATION_IMPACT_ANALYSIS_PLACEHOLDERS.some((placeholder) => lowerSummary.includes(placeholder))) {
        violations.push('analysis must replace help/command placeholders with task-specific text');
    }

    const clauses = getImpactAnalysisClauses(summary);
    for (const check of REMEDIATION_IMPACT_ANALYSIS_TOPIC_CHECKS) {
        const matchedClause = clauses.find((clause) => check.pattern.test(clause));
        if (!matchedClause) {
            violations.push(`analysis is missing topic: ${check.topic}`);
            continue;
        }
        const detail = stripTopicLikeText(matchedClause, check.topic);
        if (detail.length < REMEDIATION_IMPACT_ANALYSIS_DETAIL_MIN_CHARS) {
            violations.push(`analysis topic '${check.topic}' needs task-specific detail`);
        }
    }

    const normalizedAffectedFiles = normalizeChangedFiles(affectedFiles);
    if (
        normalizedAffectedFiles.length > 0
        && !normalizedAffectedFiles.some((entry) => lowerSummary.includes(entry.toLocaleLowerCase()))
    ) {
        violations.push(`analysis must mention at least one affected file: ${normalizedAffectedFiles.join(', ')}`);
    }

    return violations;
}

function resolveReviewRemediationImpactAnalysis(
    repoRoot: string,
    options: RestartReviewCycleCommandOptions,
    affectedFiles: readonly string[]
): ReviewRemediationImpactAnalysis {
    const pathValue = String(options.impactAnalysisPath || '').trim();
    const source = pathValue ? readImpactAnalysisPath(repoRoot, pathValue) : {
        summary: normalizeImpactAnalysisText(options.impactAnalysis),
        source: 'inline' as const
    };
    const summary = source.summary.trim();
    const violations = validateReviewRemediationImpactAnalysis(summary, affectedFiles);
    if (violations.length > 0) {
        throw new Error(
            'restart-review-cycle requires main-agent remediation impact analysis before failed-review remediation. ' +
            `Provide --impact-analysis covering: ${REMEDIATION_IMPACT_ANALYSIS_TOPICS.join('; ')}. ` +
            `Violations: ${violations.join('; ')}.`
        );
    }
    return {
        status: 'RECORDED',
        source: source.source,
        summary,
        required_topics: [...REMEDIATION_IMPACT_ANALYSIS_TOPICS],
        affected_files: normalizeChangedFiles(affectedFiles)
    };
}

function isTestLikeRemediationPath(relativePath: string, testTriggerRegexes: readonly string[]): boolean {
    return matchAnyRegex(gateHelpers.normalizePath(relativePath), [...testTriggerRegexes], {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}

function resolveCurrentRemediationChangedFiles(
    repoRoot: string,
    replayScope: ResolvedReplayScope
): string[] {
    const detectionSource = replayScope.useStaged
        ? (replayScope.includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only')
        : 'git_auto';
    const includeUntracked = replayScope.includeUntracked ?? !replayScope.useStaged;
    const snapshot = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, []);
    return normalizeChangedFiles([
        ...(replayScope.changedFiles ?? []),
        ...(snapshot.changed_files as string[])
    ]);
}

function assessReviewRemediationScopeBoundary(
    previousChangedFiles: readonly string[],
    currentChangedFiles: readonly string[],
    allowedBoundaryFiles: readonly string[] = [],
    testTriggerRegexes: readonly string[] = []
): ReviewRemediationScopeBoundary {
    const previous = normalizeChangedFiles(previousChangedFiles);
    const current = normalizeChangedFiles(currentChangedFiles);
    const previousSet = new Set(previous);
    const allowedSet = new Set(normalizeChangedFiles([...previous, ...allowedBoundaryFiles]));
    const expandedFiles = current.filter((entry) => !previousSet.has(entry));
    const unplannedExpandedFiles = current.filter((entry) => !allowedSet.has(entry));
    const expandedNonTestFiles = unplannedExpandedFiles.filter((entry) => !isTestLikeRemediationPath(entry, testTriggerRegexes));
    const allowedTestOnlyExpansionFiles = unplannedExpandedFiles.filter((entry) => isTestLikeRemediationPath(entry, testTriggerRegexes));
    return {
        status: expandedNonTestFiles.length > 0 ? 'BLOCKED' : 'OK',
        previousChangedFiles: previous,
        currentChangedFiles: current,
        expandedFiles,
        expandedNonTestFiles,
        allowedTestOnlyExpansionFiles
    };
}

function writeReviewRemediationCycleArtifact(
    repoRoot: string,
    taskId: string,
    artifact: Record<string, unknown>
): string {
    const artifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-review-remediation-cycle.json`)
    );
    writeReviewArtifactJson(artifactPath, artifact);
    return artifactPath;
}

function resolveReviewRemediationClassifyChangedFiles(
    replayScope: ResolvedReplayScope,
    scopeBoundary: ReviewRemediationScopeBoundary
): string[] | undefined {
    if (replayScope.changedFiles === undefined) {
        return undefined;
    }
    return normalizeChangedFiles([
        ...scopeBoundary.previousChangedFiles,
        ...replayScope.changedFiles,
        ...scopeBoundary.allowedTestOnlyExpansionFiles
    ]);
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
        taskModeIndexRelativePath
    ].filter(Boolean);
    const classificationConfig = getClassificationConfig(repoRoot);
    const scopeBoundary = assessReviewRemediationScopeBoundary(
        previousChangedFiles,
        currentRemediationChangedFiles,
        allowedBoundaryFiles,
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
            outputLines: [
                'REVIEW_CYCLE_RESTARTED',
                `TaskId: ${resolvedTaskId}`,
                `PreflightPath: ${gateHelpers.normalizePath(refreshedPreflightPath)}`,
                `ReviewRemediationCycleArtifact: ${gateHelpers.normalizePath(remediationArtifactPath)}`,
                `DetectionSource: ${replayScope.detectionSource}`,
                `ImpactAnalysis: recorded; affected_files=${scopeBoundary.currentChangedFiles.length}; source=${remediationImpactAnalysis.source}`,
                `ScopeBoundary: ${scopeBoundary.status}; previous=${scopeBoundary.previousChangedFiles.length}; current=${scopeBoundary.currentChangedFiles.length}; expanded_non_test=${formatReviewTypeList(scopeBoundary.expandedNonTestFiles)}`,
                `RefreshPoints: preflight=refreshed; post_preflight_rule_pack=reloaded; compile=rerun; review_contexts=${pendingReviewTypes.length > 0 ? 'partially_prepared_dependency_blocked' : 'prepared_or_reused'}`,
                `ReuseBoundaries: non_test_changes_must_stay_within_previous_preflight_scope; test_only_expansion_allowed; expanded_non_test_files_block_reuse`,
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
