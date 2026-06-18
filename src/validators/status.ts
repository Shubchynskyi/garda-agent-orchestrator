import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    resolveAgentInitStateRelativePathForTarget,
    resolveInitAnswersRelativePathForTarget
} from '../core/constants';
import { pathExists, readTextFile } from '../core/filesystem';
import { isPathInsideRoot } from '../core/paths';
import { validateInitAnswers } from '../schemas/init-answers';
import { doesAgentInitStateMatchAnswers, readAgentInitStateSafe } from '../runtime/agent-init-state';
import {
    getBundlePath,
    getCanonicalEntrypoint,
    getCommandsRulePath,
    getMissingProjectCommands,
    readUtf8IfExists,
    detectSourceBundleParity
} from './workspace-layout';
import { collectTimelineSummaryForStatus } from '../gate-runtime/timeline-summary';
import { scanProviderCompliance } from './provider-compliance';
import { evaluateProtectedControlPlaneManifest } from '../gates/shared/helpers';
import {
    collectToxinSnapshot,
    buildToxinStatusSummary
} from '../runtime/toxin-metrics';
import { assessProtectedManifest } from './protected-manifest-assessment';
import { readTaskQueueStatusMap } from './task-status-map';
import { buildRecommendedNextCommand } from './status/status-recommendations';
import { formatFullSuitePerformanceGuidance } from '../gates/full-suite/full-suite-validation';
import { getWorkflowConfigPath, isConfiguredCompileGateCommand } from '../core/workflow-config';
import type {
    AgentInitializationPendingReason,
    AgentInitState,
    AgentInitStateResult,
    InitAnswers,
    InitAnswersState,
    LiveVersionPayload,
    LiveVersionState,
    StatusSnapshot,
    TimelineSummary
} from './status/status-types';

export type { StatusSnapshot } from './status/status-types';
export {
    formatStatusSnapshot,
    formatStatusSnapshotCompact,
    formatStatusSnapshotJson
} from './status/status-rendering';

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readMandatoryFullSuiteConfig(bundlePath: string): {
    enabled: boolean | null;
    command: string | null;
    performance: string | null;
} {
    const workflowConfigPath = path.join(bundlePath, 'live', 'config', 'workflow-config.json');
    if (!pathExists(workflowConfigPath)) {
        return { enabled: null, command: null, performance: null };
    }

    try {
        const parsed = JSON.parse(readTextFile(workflowConfigPath)) as Record<string, unknown>;
        const rawSection = parsed.full_suite_validation;
        if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
            return { enabled: null, command: null, performance: null };
        }
        const section = rawSection as Record<string, unknown>;
        const enabled = section.enabled;
        const command = typeof section.command === 'string' && section.command.trim()
            ? section.command.trim()
            : null;
        return {
            enabled: typeof enabled === 'boolean' ? enabled : null,
            command,
            performance: command ? formatFullSuitePerformanceGuidance(command) : null
        };
    } catch {
        return { enabled: null, command: null, performance: null };
    }
}

function readCompileGateCommandStatus(bundlePath: string): { configured: boolean; command: string | null } {
    const workflowConfigPath = getWorkflowConfigPath(bundlePath);
    if (!pathExists(workflowConfigPath)) {
        return { configured: false, command: null };
    }

    try {
        const parsed = JSON.parse(readTextFile(workflowConfigPath)) as Record<string, unknown>;
        const rawSection = parsed.compile_gate;
        if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
            return { configured: false, command: null };
        }
        const section = rawSection as Record<string, unknown>;
        const command = typeof section.command === 'string' && section.command.trim()
            ? section.command.trim()
            : UNCONFIGURED_COMPILE_GATE_COMMAND;
        return {
            configured: isConfiguredCompileGateCommand(command),
            command
        };
    } catch {
        return { configured: false, command: null };
    }
}

function readLatestUpdateNotice(bundlePath: string): string | null {
    const reportsDir = path.join(bundlePath, 'runtime', 'update-reports');
    if (!pathExists(reportsDir) || !fs.statSync(reportsDir).isDirectory()) {
        return null;
    }

    const latestReport = fs.readdirSync(reportsDir)
        .filter((entry) => entry.toLowerCase().endsWith('.md'))
        .map((entry) => {
            const reportPath = path.join(reportsDir, entry);
            return {
                path: reportPath,
                mtimeMs: fs.statSync(reportPath).mtimeMs
            };
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs)[0];

    if (!latestReport) {
        return null;
    }

    try {
        const lines = readTextFile(latestReport.path).split(/\r?\n/);
        const updatedVersionLine = lines.find((line) => line.startsWith('UpdatedVersion: '));
        if (updatedVersionLine) {
            return updatedVersionLine.replace(/^UpdatedVersion:\s*/, '').trim();
        }
    } catch {
        return null;
    }

    return null;
}

export function resolveInitAnswersPath(targetRoot: string, initAnswersPath?: string): string {
    let candidate = String(initAnswersPath || '').trim();
    if (!candidate) {
        candidate = resolveInitAnswersRelativePathForTarget(targetRoot);
    }
    if (!path.isAbsolute(candidate)) {
        candidate = path.join(targetRoot, candidate);
    }

    const fullPath = path.resolve(candidate);
    if (!isPathInsideRoot(targetRoot, fullPath)) {
        throw new Error(`InitAnswersPath must resolve inside TargetRoot '${targetRoot}'. Resolved path: ${fullPath}`);
    }
    return fullPath;
}

export function readInitAnswersSafe(
    targetRoot: string,
    initAnswersResolvedPath: string
): { answers: InitAnswers | null; error: string | null } {
    if (!pathExists(initAnswersResolvedPath)) {
        return { answers: null, error: null };
    }

    try {
        const stats = fs.lstatSync(initAnswersResolvedPath);
        if (!stats.isFile()) {
            return {
                answers: null,
                error: `Init answers path is not a file: ${initAnswersResolvedPath}`
            };
        }
    } catch {
        return {
            answers: null,
            error: `Cannot stat init answers path: ${initAnswersResolvedPath}`
        };
    }

    try {
        const raw = readTextFile(initAnswersResolvedPath);
        if (!raw.trim()) {
            return {
                answers: null,
                error: `Init answers artifact is empty: ${initAnswersResolvedPath}`
            };
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return {
                answers: null,
                error: `Init answers artifact is not valid JSON: ${initAnswersResolvedPath}`
            };
        }

        return {
            answers: validateInitAnswers(parsed),
            error: null
        };
    } catch (error: unknown) {
        return {
            answers: null,
            error: getErrorMessage(error)
        };
    }
}

function resolveInitAnswersState(targetRoot: string, initAnswersPath?: string): InitAnswersState {
    let resolvedPath: string;
    let resolveError: string | null = null;

    try {
        resolvedPath = resolveInitAnswersPath(targetRoot, initAnswersPath);
    } catch (error: unknown) {
        resolveError = getErrorMessage(error);
        resolvedPath = resolveInitAnswersPath(
            targetRoot,
            resolveInitAnswersRelativePathForTarget(targetRoot)
        );
    }

    const present = pathExists(resolvedPath) && fs.lstatSync(resolvedPath).isFile();
    if (!present) {
        return {
            resolvedPath,
            present: false,
            answers: null,
            error: resolveError
        };
    }

    const answersResult = readInitAnswersSafe(targetRoot, resolvedPath);
    return {
        resolvedPath,
        present: true,
        answers: answersResult.answers,
        error: resolveError || answersResult.error
    };
}

function readLiveVersionState(livePath: string): LiveVersionState {
    const liveVersionPath = path.join(livePath, 'version.json');
    if (!pathExists(liveVersionPath)) {
        return { payload: null, error: null };
    }

    try {
        return {
            payload: JSON.parse(readTextFile(liveVersionPath)) as LiveVersionPayload,
            error: null
        };
    } catch (error: unknown) {
        return {
            payload: null,
            error: getErrorMessage(error)
        };
    }
}

function resolveSourceOfTruth(
    answers: InitAnswers | null,
    liveVersion: LiveVersionPayload | null
): string | null {
    if (answers) {
        return answers.SourceOfTruth;
    }

    const liveSourceOfTruth = liveVersion && String(liveVersion.SourceOfTruth || '').trim();
    return liveSourceOfTruth ? liveSourceOfTruth : null;
}

function resolveCurrentActiveAgentFiles(
    answers: InitAnswers | null,
    canonicalEntrypoint: string | null
): string[] {
    if (answers?.ActiveAgentFiles) {
        return Array.isArray(answers.ActiveAgentFiles)
            ? answers.ActiveAgentFiles.slice()
            : String(answers.ActiveAgentFiles)
                .split(/[;,]/g)
                .map((item) => item.trim())
                .filter(Boolean);
    }
    return canonicalEntrypoint ? [canonicalEntrypoint] : [];
}

function resolveAssistantLanguageState(
    answers: InitAnswers | null,
    agentInitState: AgentInitState | null
): { assistantLanguage: string | null; assistantLanguageConfirmed: boolean | null } {
    const assistantLanguageConfirmed = agentInitState
        ? agentInitState.AssistantLanguageConfirmed
        : null;
    let assistantLanguage = answers ? answers.AssistantLanguage : null;

    if (assistantLanguageConfirmed === true && agentInitState?.AssistantLanguage) {
        assistantLanguage = agentInitState.AssistantLanguage;
    } else if (!assistantLanguage && agentInitState?.AssistantLanguage) {
        assistantLanguage = agentInitState.AssistantLanguage;
    }

    return { assistantLanguage, assistantLanguageConfirmed };
}

function resolveAgentInitializationPendingReason(
    primaryInitializationComplete: boolean,
    agentInitStateResult: AgentInitStateResult,
    answers: InitAnswers | null,
    sourceOfTruth: string | null,
    currentActiveAgentFiles: string[],
    missingProjectCommands: string[]
): AgentInitializationPendingReason {
    if (!primaryInitializationComplete) {
        return null;
    }
    if (agentInitStateResult.error) {
        return 'AGENT_STATE_INVALID';
    }
    if (!agentInitStateResult.state) {
        return 'AGENT_HANDOFF_REQUIRED';
    }
    if (!doesAgentInitStateMatchAnswers(agentInitStateResult.state, {
        AssistantLanguage: answers && answers.AssistantLanguage,
        SourceOfTruth: sourceOfTruth,
        ActiveAgentFiles: currentActiveAgentFiles
    })) {
        return 'AGENT_STATE_STALE';
    }
    if (!agentInitStateResult.state.AssistantLanguageConfirmed) {
        return 'LANGUAGE_CONFIRMATION_PENDING';
    }
    if (!agentInitStateResult.state.ActiveAgentFilesConfirmed) {
        return 'ACTIVE_AGENT_FILES_PENDING';
    }
    if (!agentInitStateResult.state.ProjectRulesUpdated) {
        return 'PROJECT_RULES_PENDING';
    }
    if (!agentInitStateResult.state.SkillsPromptCompleted) {
        return 'SKILLS_PROMPT_PENDING';
    }
    if (!agentInitStateResult.state.OrdinaryDocPathsConfirmed) {
        return 'ORDINARY_DOC_PATHS_PENDING';
    }
    if (
        !agentInitStateResult.state.ProjectMemoryInitialized
        || !agentInitStateResult.state.ProjectMemoryValidated
    ) {
        return 'PROJECT_MEMORY_PENDING';
    }
    if (missingProjectCommands.length > 0) {
        return 'PROJECT_COMMANDS_PENDING';
    }
    if (!agentInitStateResult.state.VerificationPassed || !agentInitStateResult.state.ManifestValidationPassed) {
        return 'VALIDATION_PENDING';
    }
    return null;
}

function readProviderComplianceResult(
    targetRoot: string,
    bundlePresent: boolean,
    currentActiveAgentFiles: string[]
): StatusSnapshot['providerComplianceResult'] {
    if (!bundlePresent || currentActiveAgentFiles.length === 0) {
        return null;
    }

    try {
        return scanProviderCompliance(targetRoot, currentActiveAgentFiles);
    } catch {
        return null;
    }
}

function readProtectedManifestEvidence(
    targetRoot: string,
    bundlePresent: boolean
): StatusSnapshot['protectedManifestEvidence'] {
    if (!bundlePresent) {
        return null;
    }

    try {
        return evaluateProtectedControlPlaneManifest(targetRoot, null, true);
    } catch {
        return null;
    }
}

function readTimelineSummary(
    bundlePath: string,
    bundlePresent: boolean,
    taskStatuses: ReadonlyMap<string, string>
): TimelineSummary {
    if (!bundlePresent) {
        return {
            taskCount: 0,
            healthy: 0,
            warnings: []
        };
    }
    return collectTimelineSummaryForStatus(bundlePath, { taskStatuses });
}

function readActiveProfile(bundlePath: string, bundlePresent: boolean): string | null {
    if (!bundlePresent) {
        return null;
    }

    const profilesConfigPath = path.join(bundlePath, 'live', 'config', 'profiles.json');
    if (!pathExists(profilesConfigPath)) {
        return null;
    }

    try {
        const profilesRaw = JSON.parse(readTextFile(profilesConfigPath)) as Record<string, unknown>;
        if (typeof profilesRaw.active_profile === 'string' && profilesRaw.active_profile.trim()) {
            return profilesRaw.active_profile.trim();
        }
    } catch {
        return null;
    }

    return null;
}

function readToxinMetricsSummary(
    targetRoot: string,
    bundlePath: string,
    bundlePresent: boolean
): StatusSnapshot['toxinMetricsSummary'] {
    if (!bundlePresent) {
        return null;
    }

    try {
        const toxinSnapshot = collectToxinSnapshot(targetRoot, { bundleRoot: bundlePath });
        return buildToxinStatusSummary(toxinSnapshot);
    } catch {
        return null;
    }
}

export function getStatusSnapshot(targetRoot: string, initAnswersPath?: string): StatusSnapshot {
    const resolvedTargetRoot = path.resolve(targetRoot);
    const bundlePath = getBundlePath(resolvedTargetRoot);
    const bundlePresent = pathExists(bundlePath) && fs.lstatSync(bundlePath).isDirectory();
    const taskPath = path.join(resolvedTargetRoot, 'TASK.md');
    const livePath = path.join(bundlePath, 'live');
    const usagePath = path.join(livePath, 'USAGE.md');
    const commandsRulePath = getCommandsRulePath(bundlePath);
    const commandsContent = readUtf8IfExists(commandsRulePath);
    const compileGateStatus = readCompileGateCommandStatus(bundlePath);
    const missingProjectCommands = getMissingProjectCommands(commandsContent || '');
    if (bundlePresent && !compileGateStatus.configured) {
        missingProjectCommands.push('compile_gate.command');
    }
    const agentInitStateResult: AgentInitStateResult = bundlePresent
        ? readAgentInitStateSafe(
            resolvedTargetRoot,
            resolveAgentInitStateRelativePathForTarget(resolvedTargetRoot)
        )
        : {
            statePath: path.join(bundlePath, 'runtime', 'agent-init-state.json'),
            state: null,
            error: null
        };
    const initAnswersState = resolveInitAnswersState(resolvedTargetRoot, initAnswersPath);
    const liveVersionState = readLiveVersionState(livePath);
    const answers = initAnswersState.answers;
    const collectedVia = answers ? answers.CollectedVia || null : null;
    const sourceOfTruth = resolveSourceOfTruth(answers, liveVersionState.payload);
    const canonicalEntrypoint = sourceOfTruth ? getCanonicalEntrypoint(sourceOfTruth) : null;
    const livePresent = pathExists(livePath) && fs.lstatSync(livePath).isDirectory();
    const taskPresent = pathExists(taskPath) && fs.lstatSync(taskPath).isFile();
    const usagePresent = pathExists(usagePath) && fs.lstatSync(usagePath).isFile();
    const primaryInitializationComplete = (
        bundlePresent
        && initAnswersState.present
        && !initAnswersState.error
        && livePresent
        && taskPresent
        && usagePresent
    );
    const parityResult = detectSourceBundleParity(resolvedTargetRoot);
    const currentActiveAgentFiles = resolveCurrentActiveAgentFiles(answers, canonicalEntrypoint);
    const { assistantLanguage, assistantLanguageConfirmed } = resolveAssistantLanguageState(
        answers,
        agentInitStateResult.state
    );
    const agentInitializationPendingReason = resolveAgentInitializationPendingReason(
        primaryInitializationComplete,
        agentInitStateResult,
        answers,
        sourceOfTruth,
        currentActiveAgentFiles,
        missingProjectCommands
    );
    const providerComplianceResult = readProviderComplianceResult(
        resolvedTargetRoot,
        bundlePresent,
        currentActiveAgentFiles
    );
    const protectedManifestEvidence = readProtectedManifestEvidence(resolvedTargetRoot, bundlePresent);
    const protectedManifestAssessment = assessProtectedManifest({
        evidence: protectedManifestEvidence,
        parityResult,
        allowSourceCheckoutInfo: true
    });
    const agentInitializationComplete = primaryInitializationComplete && agentInitializationPendingReason === null;
    const compliancePassed = providerComplianceResult === null || providerComplianceResult.passed;
    const protectedManifestOk = protectedManifestAssessment === null || !protectedManifestAssessment.blocks;
    const readyForTasks = agentInitializationComplete && !parityResult.isStale && compliancePassed && protectedManifestOk;
    const recommendedNextCommand = buildRecommendedNextCommand({
        readyForTasks,
        bundlePath,
        parityResult,
        protectedManifestAssessment,
        primaryInitializationComplete,
        agentInitializationPendingReason,
        bundlePresent,
        initAnswersPresent: initAnswersState.present,
        initAnswersError: initAnswersState.error,
        resolvedTargetRoot,
        initAnswersPath
    });
    const activeAgentFilesValue = currentActiveAgentFiles.length > 0
        ? currentActiveAgentFiles.join(', ')
        : null;
    const taskStatuses = readTaskQueueStatusMap(taskPath, taskPresent);
    const timelineSummary = readTimelineSummary(bundlePath, bundlePresent, taskStatuses);
    const activeProfile = readActiveProfile(bundlePath, bundlePresent);
    const toxinMetricsSummary = readToxinMetricsSummary(resolvedTargetRoot, bundlePath, bundlePresent);
    const mandatoryFullSuiteConfig = bundlePresent
        ? readMandatoryFullSuiteConfig(bundlePath)
        : { enabled: null, command: null, performance: null };
    const latestUpdateNotice = bundlePresent ? readLatestUpdateNotice(bundlePath) : null;

    let enforceNoAutoCommit: boolean | null = null;
    if (liveVersionState.payload && typeof liveVersionState.payload.EnforceNoAutoCommit === 'boolean') {
        enforceNoAutoCommit = liveVersionState.payload.EnforceNoAutoCommit;
    } else if (answers && typeof answers.EnforceNoAutoCommit === 'boolean') {
        enforceNoAutoCommit = answers.EnforceNoAutoCommit;
    }

    return {
        targetRoot: resolvedTargetRoot,
        enforceNoAutoCommit,
        bundlePath,
        initAnswersResolvedPath: initAnswersState.resolvedPath,
        initAnswersPathForDisplay: initAnswersPath || resolveInitAnswersRelativePathForTarget(resolvedTargetRoot),
        bundlePresent,
        initAnswersPresent: initAnswersState.present,
        initAnswersError: initAnswersState.error,
        taskPresent,
        livePresent,
        usagePresent,
        commandsRulePath,
        missingProjectCommands,
        assistantLanguage,
        assistantLanguageConfirmed,
        sourceOfTruth,
        canonicalEntrypoint,
        collectedVia,
        agentInitStatePath: agentInitStateResult.statePath,
        agentInitStateError: agentInitStateResult.error,
        agentInitState: agentInitStateResult.state,
        activeAgentFiles: activeAgentFilesValue,
        liveVersionError: liveVersionState.error,
        primaryInitializationComplete,
        agentInitializationPendingReason,
        agentInitializationComplete,
        readyForTasks,
        recommendedNextCommand,
        activeProfile,
        timelineTaskCount: timelineSummary.taskCount,
        timelineHealthy: timelineSummary.healthy,
        timelineWarnings: timelineSummary.warnings,
        parityResult,
        providerComplianceResult,
        protectedManifestEvidence,
        protectedManifestAssessment,
        toxinMetricsSummary,
        mandatoryFullSuiteEnabled: mandatoryFullSuiteConfig.enabled,
        mandatoryFullSuiteCommand: mandatoryFullSuiteConfig.command,
        mandatoryFullSuitePerformance: mandatoryFullSuiteConfig.performance,
        latestUpdateNotice
    };
}
