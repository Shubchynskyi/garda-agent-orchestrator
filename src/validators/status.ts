import * as fs from 'node:fs';
import * as path from 'node:path';
import type { StatusSnapshot as CliStatusSnapshot } from '../cli/commands/cli-helpers';
import {
    resolveAgentInitStateRelativePathForTarget,
    resolveInitAnswersRelativePathForTarget
} from '../core/constants';
import { pathExists, readTextFile } from '../core/fs';
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
import {
    scanProviderCompliance,
    formatProviderComplianceSummary,
    type ProviderComplianceResult
} from './provider-compliance';
import {
    evaluateProtectedControlPlaneManifest,
    type ProtectedControlPlaneManifestEvidence
} from '../gates/helpers';
import {
    collectToxinSnapshot,
    buildToxinStatusSummary,
    formatToxinSummaryLines,
    type ToxinStatusSummary
} from '../runtime/toxin-metrics';
import { buildProfileAwareExecuteTaskNextCommand } from './task-command';
import {
    assessProtectedManifest,
    type ProtectedManifestAssessment
} from './protected-manifest-assessment';

type InitAnswers = ReturnType<typeof validateInitAnswers>;

interface LiveVersionPayload {
    Version?: unknown;
    SourceOfTruth?: unknown;
}

type AgentInitStateResult = ReturnType<typeof readAgentInitStateSafe>;
type AgentInitState = NonNullable<AgentInitStateResult['state']>;
type AgentInitializationPendingReason = CliStatusSnapshot['agentInitializationPendingReason'];
type TimelineSummary = ReturnType<typeof collectTimelineSummaryForStatus>;

interface InitAnswersState {
    resolvedPath: string;
    present: boolean;
    answers: InitAnswers | null;
    error: string | null;
}

interface LiveVersionState {
    payload: LiveVersionPayload | null;
    error: string | null;
}

export interface StatusSnapshot extends CliStatusSnapshot {
    initAnswersPathForDisplay: string;
    initAnswersPresent: boolean;
    taskPresent: boolean;
    livePresent: boolean;
    usagePresent: boolean;
    agentInitStatePath: string;
    agentInitState: AgentInitState | null;
    timelineTaskCount: number;
    timelineHealthy: number;
    timelineWarnings: string[];
    parityResult: ReturnType<typeof detectSourceBundleParity>;
    providerComplianceResult: ProviderComplianceResult | null;
    protectedManifestEvidence: ProtectedControlPlaneManifestEvidence | null;
    protectedManifestAssessment: ProtectedManifestAssessment | null;
    toxinMetricsSummary: ToxinStatusSummary | null;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function readMandatoryFullSuiteEnabled(bundlePath: string): boolean | null {
    const workflowConfigPath = path.join(bundlePath, 'live', 'config', 'workflow-config.json');
    if (!pathExists(workflowConfigPath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(readTextFile(workflowConfigPath)) as Record<string, unknown>;
        const rawSection = parsed.full_suite_validation;
        if (!rawSection || typeof rawSection !== 'object' || Array.isArray(rawSection)) {
            return null;
        }
        const enabled = (rawSection as Record<string, unknown>).enabled;
        return typeof enabled === 'boolean' ? enabled : null;
    } catch {
        return null;
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
): ProviderComplianceResult | null {
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
): ProtectedControlPlaneManifestEvidence | null {
    if (!bundlePresent) {
        return null;
    }

    try {
        return evaluateProtectedControlPlaneManifest(targetRoot, null, true);
    } catch {
        return null;
    }
}

function readTimelineSummary(bundlePath: string, bundlePresent: boolean): TimelineSummary {
    if (!bundlePresent) {
        return {
            taskCount: 0,
            healthy: 0,
            warnings: []
        };
    }
    return collectTimelineSummaryForStatus(bundlePath);
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
): ToxinStatusSummary | null {
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

function buildRecommendedNextCommand(options: {
    readyForTasks: boolean;
    bundlePath: string;
    parityResult: ReturnType<typeof detectSourceBundleParity>;
    protectedManifestAssessment: ProtectedManifestAssessment | null;
    primaryInitializationComplete: boolean;
    agentInitializationPendingReason: AgentInitializationPendingReason;
    bundlePresent: boolean;
    initAnswersPresent: boolean;
    initAnswersError: string | null;
    resolvedTargetRoot: string;
    initAnswersPath: string | undefined;
}): string {
    const {
        readyForTasks,
        bundlePath,
        parityResult,
        protectedManifestAssessment,
        primaryInitializationComplete,
        agentInitializationPendingReason,
        bundlePresent,
        initAnswersPresent,
        initAnswersError,
        resolvedTargetRoot,
        initAnswersPath
    } = options;

    if (readyForTasks) {
        return buildProfileAwareExecuteTaskNextCommand(bundlePath);
    }
    if (parityResult.isStale && parityResult.remediation) {
        return parityResult.remediation;
    }

    const protectedManifestNeedsRepair = protectedManifestAssessment?.requires_refresh === true;
    if (protectedManifestNeedsRepair) {
        return `npx garda-agent-orchestrator update --target-root "${resolvedTargetRoot}"`;
    }
    if (primaryInitializationComplete && agentInitializationPendingReason !== null) {
        return `Give your agent "${path.join(bundlePath, 'AGENT_INIT_PROMPT.md')}" and complete the agent-init flow`;
    }
    if (bundlePresent && (!initAnswersPresent || initAnswersError)) {
        return `npx garda-agent-orchestrator setup --target-root "${resolvedTargetRoot}"`;
    }
    if (bundlePresent) {
        return `npx garda-agent-orchestrator install --target-root "${resolvedTargetRoot}" --init-answers-path "${initAnswersPath}"`;
    }
    return 'npx garda-agent-orchestrator setup';
}

function buildHeadlineText(snapshot: StatusSnapshot): string {
    if (snapshot.readyForTasks) {
        return 'Workspace ready';
    }
    if (snapshot.primaryInitializationComplete) {
        return 'Agent setup required';
    }
    if (snapshot.bundlePresent) {
        return 'Primary setup required';
    }
    return 'Not installed';
}

function buildBadge(enabled: boolean): string {
    return enabled ? '[x]' : '[ ]';
}

function buildSeverityBadge(severity: 'pass' | 'warn' | 'fail'): string {
    switch (severity) {
        case 'pass':
            return '[x]';
        case 'warn':
            return '[~]';
        default:
            return '[ ]';
    }
}

function appendParityLines(lines: string[], snapshot: StatusSnapshot): void {
    if (!snapshot.parityResult.isSourceCheckout) {
        return;
    }

    lines.push(`  ${buildBadge(!snapshot.parityResult.isStale)} Source parity (Self-hosted)`);
    if (!snapshot.parityResult.isStale) {
        return;
    }
    for (const violation of snapshot.parityResult.violations) {
        lines.push(`    Violation: ${violation}`);
    }
}

function appendProviderComplianceLines(lines: string[], snapshot: StatusSnapshot): void {
    if (!snapshot.providerComplianceResult) {
        return;
    }

    lines.push(`  ${buildBadge(snapshot.providerComplianceResult.passed)} Provider control compliance`);
    if (snapshot.providerComplianceResult.passed) {
        return;
    }

    const complianceLines = formatProviderComplianceSummary(snapshot.providerComplianceResult);
    for (const line of complianceLines.slice(1)) {
        lines.push(`  ${line}`);
    }
}

function appendProtectedManifestLines(lines: string[], snapshot: StatusSnapshot): void {
    if (!snapshot.protectedManifestEvidence) {
        return;
    }

    const manifestStatus = snapshot.protectedManifestEvidence.status;
    const manifestAssessment = snapshot.protectedManifestAssessment;
    const manifestSeverity = manifestAssessment?.severity
        || (manifestStatus === 'MATCH' || manifestStatus === 'MISSING' ? 'pass' : 'fail');
    lines.push(`  ${buildSeverityBadge(manifestSeverity)} Protected manifest (${manifestStatus})`);

    if (manifestAssessment?.code === 'INFO_SOURCE_CHECKOUT') {
        lines.push('    Assessment: INFO_SOURCE_CHECKOUT');
        lines.push('    Info: self-hosted source-checkout drift is informational while protected source and generated bundle files evolve together.');
        lines.push('    Impact: status keeps the workspace ready, while task-start gates still enforce dirty-baseline and manifest guardrails for true pre-start drift.');
        lines.push('    Optional: Run setup/update/reinit after intentional control-plane changes settle and you want to refresh the trusted baseline.');
        return;
    }

    if (manifestAssessment?.code === 'INFO_TASK_CONTEXT_ALLOWED_DRIFT') {
        lines.push('    Assessment: INFO_TASK_CONTEXT_ALLOWED_DRIFT');
        lines.push('    Info: current task context already explains this protected-manifest drift.');
        return;
    }

    if (manifestStatus === 'DRIFT') {
        const driftCount = snapshot.protectedManifestEvidence.changed_files.length;
        lines.push(`    Drift: ${driftCount} file(s) changed since last trusted snapshot`);
        for (const changedFile of snapshot.protectedManifestEvidence.changed_files.slice(0, 5)) {
            lines.push(`    - ${changedFile}`);
        }
        if (driftCount > 5) {
            lines.push(`    ... and ${driftCount - 5} more`);
        }
        lines.push('    Fix: Run setup/update/reinit to refresh the trusted lifecycle baseline, or restart with --orchestrator-work if the task intentionally changes orchestrator control-plane files.');
        return;
    }

    if (manifestStatus === 'INVALID') {
        lines.push('    Warning: trusted manifest is malformed; re-run setup/update/reinit');
        lines.push('    Fix: Run setup/update/reinit before ordinary tasks, or restart with --orchestrator-work if this task intentionally changes orchestrator control-plane files.');
    }
}

function buildPendingCheckpointLine(snapshot: StatusSnapshot): string | null {
    switch (snapshot.agentInitializationPendingReason) {
        case 'AGENT_HANDOFF_REQUIRED':
            return '  Next stage: Launch your agent with AGENT_INIT_PROMPT.md';
        case 'LANGUAGE_CONFIRMATION_PENDING':
            return '  Pending checkpoint: Confirm assistant language during AGENT_INIT_PROMPT flow';
        case 'ACTIVE_AGENT_FILES_PENDING':
            return '  Pending checkpoint: Confirm active agent files during AGENT_INIT_PROMPT flow';
        case 'AGENT_STATE_STALE':
            return '  Pending checkpoint: Agent-init state no longer matches current init answers; rerun AGENT_INIT_PROMPT flow';
        case 'PROJECT_RULES_PENDING':
            return '  Pending checkpoint: Update project-specific live rules before finalizing agent init';
        case 'SKILLS_PROMPT_PENDING':
            return '  Pending checkpoint: Ask the built-in specialist skills question before finalizing agent init';
        case 'PROJECT_COMMANDS_PENDING':
            return `  Missing project commands: ${snapshot.missingProjectCommands.length}`;
        case 'VALIDATION_PENDING':
            return '  Pending checkpoint: Run agent-init validation to get verify + manifest PASSED';
        case 'AGENT_STATE_INVALID':
            return '  Pending checkpoint: Repair invalid agent-init state file';
        default:
            return null;
    }
}

function appendTimelineLines(lines: string[], snapshot: StatusSnapshot): void {
    if (snapshot.timelineTaskCount === 0) {
        return;
    }

    lines.push(`TaskTimelines: ${snapshot.timelineHealthy}/${snapshot.timelineTaskCount} complete`);
    for (const warning of snapshot.timelineWarnings) {
        lines.push(`  Warning: ${warning}`);
    }
}

function appendToxinLines(lines: string[], snapshot: StatusSnapshot): void {
    if (!snapshot.toxinMetricsSummary) {
        return;
    }

    lines.push('');
    lines.push('Toxin Metrics');
    for (const line of formatToxinSummaryLines(snapshot.toxinMetricsSummary)) {
        lines.push(`  ${line}`);
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
    const missingProjectCommands = getMissingProjectCommands(commandsContent || '');
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
    const timelineSummary = readTimelineSummary(bundlePath, bundlePresent);
    const activeProfile = readActiveProfile(bundlePath, bundlePresent);
    const toxinMetricsSummary = readToxinMetricsSummary(resolvedTargetRoot, bundlePath, bundlePresent);
    const mandatoryFullSuiteEnabled = bundlePresent ? readMandatoryFullSuiteEnabled(bundlePath) : null;
    const latestUpdateNotice = bundlePresent ? readLatestUpdateNotice(bundlePath) : null;

    return {
        targetRoot: resolvedTargetRoot,
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
        mandatoryFullSuiteEnabled,
        latestUpdateNotice
    };
}

export function formatStatusSnapshot(snapshot: StatusSnapshot, options?: { heading?: string }): string {
    const heading = options?.heading || 'GARDA_STATUS';
    const lines: string[] = [
        heading,
        buildHeadlineText(snapshot),
        `Project: ${snapshot.targetRoot}`,
        `Bundle: ${snapshot.bundlePath}`,
        `InitAnswers: ${snapshot.initAnswersResolvedPath}`,
        `CollectedVia: ${snapshot.collectedVia || 'n/a'}`
    ];

    if (snapshot.activeAgentFiles) {
        lines.push(`ActiveAgentFiles: ${snapshot.activeAgentFiles}`);
    }
    lines.push(
        `SourceOfTruth: ${snapshot.sourceOfTruth || 'n/a'}`
        + `${snapshot.canonicalEntrypoint ? ` -> ${snapshot.canonicalEntrypoint}` : ''}`
    );
    if (snapshot.activeProfile) {
        lines.push(`ActiveProfile: ${snapshot.activeProfile}`);
    }

    lines.push('');
    lines.push('Workspace Stages');
    lines.push(`  ${buildBadge(snapshot.bundlePresent)} Installed`);
    lines.push(`  ${buildBadge(snapshot.primaryInitializationComplete)} Primary initialization`);
    lines.push(`  ${buildBadge(snapshot.agentInitializationComplete)} Agent initialization`);

    appendParityLines(lines, snapshot);
    appendProviderComplianceLines(lines, snapshot);
    appendProtectedManifestLines(lines, snapshot);

    lines.push(`  ${buildBadge(snapshot.readyForTasks)} Ready for task execution`);

    const pendingCheckpointLine = buildPendingCheckpointLine(snapshot);
    if (pendingCheckpointLine) {
        lines.push(pendingCheckpointLine);
    }
    if (snapshot.initAnswersError) {
        lines.push(`InitAnswersStatus: INVALID (${snapshot.initAnswersError})`);
    }
    if (snapshot.liveVersionError) {
        lines.push(`LiveVersionStatus: INVALID (${snapshot.liveVersionError})`);
    }
    if (snapshot.agentInitStateError) {
        lines.push(`AgentInitStateStatus: INVALID (${snapshot.agentInitStateError})`);
    }

    appendTimelineLines(lines, snapshot);
    appendToxinLines(lines, snapshot);

    lines.push(`RecommendedNextCommand: ${snapshot.recommendedNextCommand}`);
    return lines.join('\n');
}

export function formatStatusSnapshotCompact(snapshot: StatusSnapshot): string {
    if (!snapshot.readyForTasks) {
        return formatStatusSnapshot(snapshot);
    }
    const profileSuffix = snapshot.activeProfile ? ` | profile=${snapshot.activeProfile}` : '';
    const toxinSuffix = snapshot.toxinMetricsSummary && snapshot.toxinMetricsSummary.warnings.length > 0
        ? ` | toxin_warnings=${snapshot.toxinMetricsSummary.warnings.length}`
        : '';
    return `GARDA_STATUS: ready | source=${snapshot.sourceOfTruth || 'n/a'}${profileSuffix}${toxinSuffix}`;
}

export function formatStatusSnapshotJson(snapshot: StatusSnapshot): string {
    return JSON.stringify(snapshot, null, 2);
}
