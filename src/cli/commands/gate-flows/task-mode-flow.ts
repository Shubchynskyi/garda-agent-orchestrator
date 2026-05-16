import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../exit-codes';
import {
    normalizeOrchestratorStartBanner,
    ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE
} from '../../../core/orchestrator-start-banner';
import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleName
} from '../../../core/constants';
import {
    parseOperatorConfirmationYes,
    validateFreshOperatorConfirmation
} from '../../../core/operator-confirmation';
import {
    formatGardaSelfGuardProtectedControlPlaneGuidance,
    readOrchestratorWorkPolicyModeForBundle
} from '../../../core/workflow-config';
import {
    emitHandshakeDiagnosticsEvent,
    emitShellSmokePreflightEvent,
    emitCommandTimeoutDiagnosticsEvent,
    emitPlanCreatedEvent,
    emitProviderRoutingEvent,
    emitStatusChangedEvent
} from '../../../gate-runtime/lifecycle-events';
import {
    appendMandatoryTaskEvent,
    appendTaskEvent,
    assertValidTaskId
} from '../../../gate-runtime/task-events';
import { withFilesystemLock } from '../../../gate-runtime/task-events-locking';
import {
    buildRulePackArtifact,
    getPostPreflightRulePackRebindDecision,
    resolveRulePackArtifactPath
} from '../../../gates/rule-pack';
import {
    buildHandshakeDiagnostics,
    formatHandshakeDiagnosticsResult,
    getHandshakeEvidence,
    getHandshakeEvidenceViolations,
    resolveHandshakeArtifactPath
} from '../../../gates/handshake-diagnostics';
import {
    buildShellSmokePreflight,
    formatShellSmokePreflightResult,
    getShellSmokeEvidence,
    resolveShellSmokeArtifactPath
} from '../../../gates/shell-smoke-preflight';
import {
    buildCommandTimeoutDiagnostics,
    formatCommandTimeoutDiagnosticsResult,
    resolveCommandTimeoutArtifactPath,
    type CommandPhaseRecord
} from '../../../gates/command-timeout-diagnostics';
import {
    buildTaskModeArtifact,
    normalizeTaskModeEntryMode,
    parseTaskModeDepth,
    resolveTaskModeArtifactPath,
    type TaskModePlanMetadata
} from '../../../gates/task-mode';
import { resolveReviewerRoutingPolicy } from '../../../gates/reviewer-routing';
import { captureDirtyWorkspaceBaseline } from '../../../gates/dirty-worktree-protection';
import {
    validateTaskPlan,
    computeTaskPlanDigest,
    isApprovedPlan
} from '../../../schemas/task-plan';
import {
    buildNoOpArtifact,
    resolveNoOpArtifactPath
} from '../../../gates/no-op';
import {
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigControlPlanePaths,
    getWorkflowConfigPreTaskBaselineState
} from '../../../gates/workflow-config-work';
import {
    readTaskQueueMetadata
} from '../../../gates/task-audit-summary-collectors';
import * as gateHelpers from '../../../gates/helpers';
import {
    resolveTaskProfileSelection
} from '../../../policy/task-profile-selection';
import {
    normalizeOptionalPath,
    removeArtifactIfExists,
    resolveDefaultMetricsPath,
    resolvePathForWrite,
    writeJsonArtifact
} from '../gates-artifacts';
import {
    expandValueList,
    normalizeRulePackStage,
    parseBooleanOption
} from '../gates-parser';
import { requireResolvedPath } from '../shared-command-utils';
import {
    getErrorMessage,
    resolveOrchestratorRoot,
    appendMetricsIfEnabled
} from './gate-flow-helpers';
import { readRoutingDecision } from './routing-decision';
import { readTaskQueueStatus, syncTaskQueueStatus } from './task-queue-sync';

export const WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE = 'workflow-config policy changes';

export interface EnterTaskModeCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    entryMode?: unknown;
    requestedDepth?: unknown;
    effectiveDepth?: unknown;
    taskSummary?: unknown;
    startBanner?: unknown;
    plannedChangedFiles?: unknown;
    orchestratorWork?: unknown;
    workflowConfigWork?: unknown;
    operatorConfirmed?: unknown;
    operatorConfirmedAtUtc?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    actor?: unknown;
    planPath?: string;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface LoadRulePackCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    stage?: unknown;
    preflightPath?: string;
    taskModePath?: string;
    loadedRuleFiles?: unknown;
    actor?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface BindRulePackToPreflightCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    preflightPath?: string;
    taskModePath?: string;
    actor?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface RecordNoOpCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    classification?: unknown;
    reason?: unknown;
    actor?: unknown;
    preflightPath?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface HandshakeDiagnosticsCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    provider?: unknown;
    taskModePath?: string;
    cliPath?: unknown;
    effectiveCwd?: unknown;
    canonicalEntrypoint?: unknown;
    providerBridge?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface ShellSmokePreflightCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    taskModePath?: string;
    effectiveCwd?: unknown;
    probeTimeoutMs?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface CommandTimeoutDiagnosticsCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    taskModePath?: string;
    effectiveCwd?: unknown;
    commandRecordsPath?: string;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

function quotePowerShellCliValue(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizePlannedChangedFiles(repoRoot: string, rawValues: unknown): string[] {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const unique = new Set<string>();
    for (const rawValue of expandValueList(rawValues || [], { splitDelimiters: true })) {
        const rawPath = String(rawValue || '').trim();
        if (!rawPath) {
            continue;
        }
        const resolvedPath = gateHelpers.resolvePathInsideRepo(rawPath, normalizedRepoRoot, { allowMissing: true });
        if (!resolvedPath) {
            continue;
        }
        const relativePath = gateHelpers.normalizePath(path.relative(normalizedRepoRoot, resolvedPath));
        if (!relativePath || relativePath === '.' || relativePath.startsWith('../')) {
            throw new Error(`PlannedChangedFile must stay inside repo root. Got '${rawPath}'.`);
        }
        unique.add(relativePath);
    }
    return [...unique].sort();
}

function buildOrchestratorWorkHandoffCommand(
    repoRoot: string,
    taskId: string,
    options: EnterTaskModeCommandOptions,
    plannedChangedFiles: string[],
    includeWorkflowConfigWork = false
): string {
    const cliPrefix = gateHelpers.isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
    const parts: string[] = [
        `${cliPrefix} gate enter-task-mode`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--entry-mode ${quotePowerShellCliValue(normalizeTaskModeEntryMode(options.entryMode || 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quotePowerShellCliValue(String(parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', 2)))}`,
        `--task-summary ${quotePowerShellCliValue(String(options.taskSummary || '').trim())}`,
        '--orchestrator-work'
    ];
    if (includeWorkflowConfigWork) {
        parts.push('--workflow-config-work');
    }
    const startBanner = String(options.startBanner || '').trim();
    if (startBanner) {
        parts.push(`--start-banner ${quotePowerShellCliValue(startBanner)}`);
    }

    const effectiveDepthRaw = String(options.effectiveDepth || '').trim();
    if (effectiveDepthRaw) {
        parts.push(`--effective-depth ${quotePowerShellCliValue(String(parseTaskModeDepth(effectiveDepthRaw, 'EffectiveDepth', 2)))}`);
    }
    const provider = String(options.provider || '').trim();
    if (provider) {
        parts.push(`--provider ${quotePowerShellCliValue(provider)}`);
    }
    const routedTo = String(options.routedTo || '').trim();
    if (routedTo) {
        parts.push(`--routed-to ${quotePowerShellCliValue(routedTo)}`);
    }
    const actor = String(options.actor || '').trim();
    if (actor) {
        parts.push(`--actor ${quotePowerShellCliValue(actor)}`);
    }
    const planPath = String(options.planPath || '').trim();
    if (planPath) {
        parts.push(`--plan-path ${quotePowerShellCliValue(planPath)}`);
    }
    const artifactPath = String(options.artifactPath || '').trim();
    if (artifactPath) {
        parts.push(`--artifact-path ${quotePowerShellCliValue(artifactPath)}`);
    }
    const metricsPath = String(options.metricsPath || '').trim();
    if (metricsPath) {
        parts.push(`--metrics-path ${quotePowerShellCliValue(metricsPath)}`);
    }
    if (options.emitMetrics === false || String(options.emitMetrics || '').trim().toLowerCase() === 'false') {
        parts.push('--emit-metrics false');
    }
    for (const plannedChangedFile of plannedChangedFiles) {
        parts.push(`--planned-changed-file ${quotePowerShellCliValue(plannedChangedFile)}`);
    }
    return parts.join(' ');
}

function buildGateCommandPrefix(repoRoot: string): string {
    return gateHelpers.isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
}

function taskMetadataAllowsWorkflowConfigWork(taskQueueMetadata: ReturnType<typeof readTaskQueueMetadata>): boolean {
    if (!taskQueueMetadata) {
        return false;
    }
    const trustedTaskText = [
        taskQueueMetadata.area,
        taskQueueMetadata.title,
        taskQueueMetadata.notes
    ].filter(Boolean).join(' ').toLowerCase();
    return trustedTaskText.includes(WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE);
}

function isGardaSelfGuardDenyAgentEntry(repoRoot: string, orchestratorRoot: string): boolean {
    return !gateHelpers.isOrchestratorSourceCheckout(repoRoot)
        && readOrchestratorWorkPolicyModeForBundle(orchestratorRoot) === 'deny_agent_entry';
}

function buildGardaSelfGuardDenialMessage(protectedFiles: readonly string[]): string {
    return formatGardaSelfGuardProtectedControlPlaneGuidance({
        protectedFiles,
        includeWorkflowConfigWork: true
    });
}

function requireTaskModeOperatorConfirmation(
    options: EnterTaskModeCommandOptions,
    scopeLabel: string
): void {
    const rawConfirmation = String(options.operatorConfirmed || '').trim();
    const confirmed = rawConfirmation ? parseOperatorConfirmationYes(rawConfirmation) : false;
    validateFreshOperatorConfirmation({
        actionLabel: `enter-task-mode ${scopeLabel}`,
        confirmed,
        confirmedAtUtc: String(options.operatorConfirmedAtUtc || '').trim(),
        requireConfirmedAtUtc: true,
        instruction:
            'Ask the operator to approve this protected task-mode entry, then rerun with --operator-confirmed yes and --operator-confirmed-at-utc "<ISO-8601 timestamp>". ' +
            'Agents must not approve --orchestrator-work or --workflow-config-work for themselves.'
    });
}

function buildGateRerunCommand(repoRoot: string, taskId: string, gateName: string, taskModePath = ''): string {
    const parts = [
        `${buildGateCommandPrefix(repoRoot)} gate ${gateName}`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`
    ];
    const trimmedTaskModePath = String(taskModePath || '').trim();
    if (trimmedTaskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(trimmedTaskModePath)}`);
    }
    return parts.join(' ');
}

function buildLoadRulePackPostPreflightRemediationCommand(
    repoRoot: string,
    taskId: string,
    preflightPath: string | null,
    requiredRuleFiles: string[],
    taskModePath = ''
): string {
    const absoluteRepoRoot = path.resolve(repoRoot);
    const parts: string[] = [
        `${buildGateCommandPrefix(repoRoot)} gate load-rule-pack`,
        `--repo-root ${quotePowerShellCliValue(absoluteRepoRoot)}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--stage ${quotePowerShellCliValue('POST_PREFLIGHT')}`
    ];
    if (preflightPath) {
        const relativePreflightPath = gateHelpers.normalizePath(
            path.relative(absoluteRepoRoot, path.resolve(preflightPath))
        );
        parts.push(`--preflight-path ${quotePowerShellCliValue(relativePreflightPath)}`);
    }
    const trimmedTaskModePath = String(taskModePath || '').trim();
    if (trimmedTaskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(trimmedTaskModePath)}`);
    }
    for (const ruleFile of requiredRuleFiles) {
        const relativeRuleFile = gateHelpers.normalizePath(
            path.relative(absoluteRepoRoot, path.resolve(ruleFile))
        );
        parts.push(`--loaded-rule-file ${quotePowerShellCliValue(relativeRuleFile)}`);
    }
    return parts.join(' ');
}

function buildTaskModeIdentitySuggestionCommand(
    repoRoot: string,
    taskId: string,
    routingDecision: ReturnType<typeof readRoutingDecision>,
    artifactPath = ''
): string {
    const commandParts = [
        `${buildGateCommandPrefix(repoRoot)} gate enter-task-mode`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        '--task-summary "<task-summary>"'
    ];
    if (routingDecision.provider) {
        commandParts.push(`--provider ${quotePowerShellCliValue(routingDecision.provider)}`);
    } else {
        commandParts.push('--provider "<provider>"');
    }
    const safeRoutedIdentityHint = routingDecision.identityStatus !== 'contradictory'
        ? (
            routingDecision.reviewerSubagentLaunchRoute
            || routingDecision.routedTo
            || routingDecision.providerBridge
            || routingDecision.executionEntrypoint
            || routingDecision.canonicalEntrypoint
        )
        : null;
    if (safeRoutedIdentityHint) {
        commandParts.push(`--routed-to ${quotePowerShellCliValue(safeRoutedIdentityHint)}`);
    }
    const trimmedArtifactPath = String(artifactPath || '').trim();
    if (trimmedArtifactPath) {
        commandParts.push(`--artifact-path ${quotePowerShellCliValue(trimmedArtifactPath)}`);
    }
    return commandParts.join(' ');
}

function assertLaunchableReviewerSubagents(
    repoRoot: string,
    taskId: string,
    stageLabel: string,
    routingDecision: ReturnType<typeof readRoutingDecision>,
    rerunGateName: string | null = null,
    taskModePath = ''
): void {
    const reviewerSubagentLaunchStatus = String(routingDecision.reviewerSubagentLaunchStatus || '').trim() || 'unknown';
    if (reviewerSubagentLaunchStatus === 'launchable') {
        return;
    }

    const reviewerSubagentLaunchReason = String(routingDecision.reviewerSubagentLaunchReason || '').trim();
    const reviewerSubagentLaunchRemediation = String(routingDecision.reviewerSubagentLaunchRemediation || '').trim();
    const errorParts = [
        `Reviewer subagent launchability is '${reviewerSubagentLaunchStatus}' ${stageLabel}.`
    ];
    if (reviewerSubagentLaunchReason) {
        errorParts.push(reviewerSubagentLaunchReason);
    }
    if (reviewerSubagentLaunchRemediation) {
        errorParts.push(reviewerSubagentLaunchRemediation);
    }
    if (rerunGateName) {
        errorParts.push(
            `Suggested commands: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, taskModePath)} ; ` +
            `${buildGateRerunCommand(repoRoot, taskId, rerunGateName, taskModePath)}`
        );
    } else {
        errorParts.push(`Suggested command: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, taskModePath)}`);
    }
    throw new Error(errorParts.join(' '));
}

function assertTaskModeRuntimeIdentity(
    repoRoot: string,
    taskId: string,
    routingDecision: ReturnType<typeof readRoutingDecision>,
    artifactPath = ''
): void {
    if (!routingDecision.canonicalSourceOfTruth) {
        throw new Error(
            'Canonical SourceOfTruth is missing at task-mode entry. Re-run setup/reinit to restore canonical owner files ' +
            `before starting '${taskId}'. Suggested command: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, artifactPath)}`
        );
    }

    if (routingDecision.identityStatus === 'resolved') {
        assertLaunchableReviewerSubagents(repoRoot, taskId, 'at task-mode entry', routingDecision, null, artifactPath);
        return;
    }

    const violationText = routingDecision.violations.length > 0
        ? ` ${routingDecision.violations.join(' ')}`
        : '';
    const remediation = 'Re-run enter-task-mode with explicit runtime identity via `--provider "<provider>"` ' +
        'and add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned. ' +
        'Do not infer runtime provider from canonical SourceOfTruth.';

    throw new Error(
        `Runtime execution identity is '${routingDecision.identityStatus}' at task-mode entry.${violationText} ${remediation} ` +
        `Suggested command: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, artifactPath)}`
    );
}

function assertResolvedRuntimeIdentityForDependentPreflightGate(
    repoRoot: string,
    taskId: string,
    gateName: string,
    routingDecision: ReturnType<typeof readRoutingDecision>,
    taskModePath = ''
): void {
    if (!routingDecision.canonicalSourceOfTruth) {
        throw new Error(
            `Canonical SourceOfTruth is missing before ${gateName}. Re-run setup/reinit to restore canonical owner files, ` +
            `then re-enter task mode before ${gateName}. Suggested commands: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, taskModePath)} ; ` +
            `${buildGateRerunCommand(repoRoot, taskId, gateName, taskModePath)}`
        );
    }

    if (routingDecision.identityStatus === 'resolved') {
        assertLaunchableReviewerSubagents(
            repoRoot,
            taskId,
            `before ${gateName}`,
            routingDecision,
            gateName,
            taskModePath
        );
        return;
    }

    const violationText = routingDecision.violations.length > 0
        ? ` ${routingDecision.violations.join(' ')}`
        : '';
    const remediation = 'Re-enter task mode with explicit runtime identity via `--provider "<provider>"` ' +
        'and add `--routed-to "<provider-bridge-or-entrypoint>"` only when route telemetry must be pinned. ' +
        'Do not infer runtime provider from canonical SourceOfTruth.';

    throw new Error(
        `Runtime execution identity is '${routingDecision.identityStatus}' before ${gateName}.${violationText} ${remediation} ` +
        `Suggested commands: ${buildTaskModeIdentitySuggestionCommand(repoRoot, taskId, routingDecision, taskModePath)} ; ` +
        `${buildGateRerunCommand(repoRoot, taskId, gateName, taskModePath)}`
    );
}

function resolvePrePreflightSequenceLockPath(repoRoot: string, taskId: string): string {
    return gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'task-events', `${taskId}-pre-preflight-sequence.lock`)
    );
}

function resolveTaskModeStartBanner(
    requestedStartBanner: unknown
): string | null {
    const requestedBanner = String(requestedStartBanner || '').trim();
    if (requestedBanner) {
        const normalizedRequestedBanner = normalizeOrchestratorStartBanner(requestedBanner);
        if (!normalizedRequestedBanner) {
            throw new Error(
                `StartBanner must be one of the repo-owned banners (${ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE}). ` +
                `Got '${requestedBanner}'.`
            );
        }
        return normalizedRequestedBanner;
    }

    return null;
}

export function runEnterTaskModeCommand(options: EnterTaskModeCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const artifactPath = resolveTaskModeArtifactPath(repoRoot, taskId, String(options.artifactPath || ''));
    // A new task-mode entry must never inherit runtime identity from an older task-mode artifact.
    const routingDecision = readRoutingDecision(repoRoot, options.provider, options.routedTo);
    assertTaskModeRuntimeIdentity(repoRoot, taskId, routingDecision, artifactPath);
    const dirtyWorkspaceBaseline = captureDirtyWorkspaceBaseline(repoRoot);
    const workflowConfigFileHashes = getCurrentWorkflowConfigFileHashes(repoRoot);
    const plannedChangedFiles = normalizePlannedChangedFiles(repoRoot, options.plannedChangedFiles);
    const protectedPlannedFiles = plannedChangedFiles.filter((entry) =>
        gateHelpers.testPathPrefix(entry, gateHelpers.getProtectedControlPlaneRoots(repoRoot))
    );
    const orchestratorWork = parseBooleanOption(options.orchestratorWork, false);
    const workflowConfigWork = parseBooleanOption(options.workflowConfigWork, false);
    const workflowConfigControlPlanePaths = new Set(getWorkflowConfigControlPlanePaths(repoRoot));
    const workflowConfigPlannedFiles = plannedChangedFiles.filter((entry) =>
        workflowConfigControlPlanePaths.has(gateHelpers.normalizePath(entry))
    );
    const workflowConfigPreTaskBaseline = getWorkflowConfigPreTaskBaselineState(repoRoot, workflowConfigFileHashes);
    const dirtyWorkflowConfigFiles = [...workflowConfigPreTaskBaseline.changed_files].sort();
    const startBanner = resolveTaskModeStartBanner(options.startBanner);
    const selfGuardDenyAgentEntry = isGardaSelfGuardDenyAgentEntry(repoRoot, orchestratorRoot);

    let planMetadata: TaskModePlanMetadata | null = null;
    const rawPlanPath = String(options.planPath || '').trim();
    if (rawPlanPath) {
        const resolvedPlanPath = gateHelpers.resolvePathInsideRepo(rawPlanPath, repoRoot, { allowMissing: false });
        if (!resolvedPlanPath || !fs.existsSync(resolvedPlanPath) || !fs.statSync(resolvedPlanPath).isFile()) {
            throw new Error(`PlanPath not found or not a file: '${rawPlanPath}'.`);
        }
        const planJson = JSON.parse(fs.readFileSync(resolvedPlanPath, 'utf8'));
        const validated = validateTaskPlan(planJson);
        if (validated.task_id !== taskId) {
            throw new Error(`Plan task_id '${validated.task_id}' does not match --task-id '${taskId}'.`);
        }
        if (!isApprovedPlan(validated)) {
            throw new Error(`Plan status is '${validated.status}'; only approved plans can be attached at task-mode entry.`);
        }
        const digest = computeTaskPlanDigest(validated);
        if (validated.plan_sha256 && validated.plan_sha256 !== digest) {
            throw new Error(`Plan plan_sha256 mismatch: embedded '${validated.plan_sha256}' vs computed '${digest}'.`);
        }
        planMetadata = {
            plan_path: gateHelpers.normalizePath(resolvedPlanPath),
            plan_sha256: digest,
            plan_summary: validated.goal
        };
    }

    const taskQueueMetadata = readTaskQueueMetadata(repoRoot, taskId);

    if (dirtyWorkflowConfigFiles.length > 0) {
        throw new Error(
            `Workspace already contains workflow config changes before task-mode entry: ${dirtyWorkflowConfigFiles.join(', ')}. ` +
            'Enter task mode before editing workflow-config.json so the change cannot be laundered into the baseline.'
        );
    }

    if (
        selfGuardDenyAgentEntry
        && (orchestratorWork || workflowConfigWork || protectedPlannedFiles.length > 0)
    ) {
        throw new Error(buildGardaSelfGuardDenialMessage(protectedPlannedFiles));
    }

    if (workflowConfigWork && !orchestratorWork) {
        const rerunCommand = buildOrchestratorWorkHandoffCommand(repoRoot, taskId, options, plannedChangedFiles, true);
        throw new Error(
            'Task-mode --workflow-config-work requires --orchestrator-work because workflow-config.json is part of the protected orchestrator control plane. ' +
            `Suggested command: ${rerunCommand}`
        );
    }

    if (workflowConfigWork && workflowConfigPlannedFiles.length === 0) {
        throw new Error(
            'Task-mode --workflow-config-work requires the planned task scope to include a protected workflow-config.json file. ' +
            'Add the intended workflow-config.json path to the planned changed files before entering task mode.'
        );
    }

    if (workflowConfigWork && !taskMetadataAllowsWorkflowConfigWork(taskQueueMetadata)) {
        throw new Error(
            'Task-mode --workflow-config-work requires trusted TASK.md metadata to explicitly own workflow-config policy changes. ' +
            `Update the task row Area, Title, or Notes to include the exact ownership phrase '${WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE}' before entering task mode.`
        );
    }

    if (workflowConfigPlannedFiles.length > 0 && !workflowConfigWork) {
        const rerunCommand = buildOrchestratorWorkHandoffCommand(repoRoot, taskId, options, plannedChangedFiles, true);
        throw new Error(
            `Planned task scope includes workflow config files: ${workflowConfigPlannedFiles.join(', ')}. ` +
            'Re-run enter-task-mode with --orchestrator-work --workflow-config-work before preflight so this high-risk config intent stays explicit and auditable. ' +
            `Suggested command: ${rerunCommand}`
        );
    }

    if (!orchestratorWork && protectedPlannedFiles.length > 0) {
        const rerunCommand = buildOrchestratorWorkHandoffCommand(repoRoot, taskId, options, plannedChangedFiles, workflowConfigWork);
        throw new Error(
            `Planned task scope includes protected orchestrator files: ${protectedPlannedFiles.join(', ')}. ` +
            'Re-run enter-task-mode with --orchestrator-work before preflight so the intent stays explicit and auditable. ' +
            `Suggested command: ${rerunCommand}`
        );
    }

    if (orchestratorWork || workflowConfigWork) {
        requireTaskModeOperatorConfirmation(
            options,
            workflowConfigWork ? '--orchestrator-work --workflow-config-work' : '--orchestrator-work'
        );
    }

    const rawTaskProfile = taskQueueMetadata?.profile || null;
    let taskProfile: string | null = null;
    let profileSelectionSource: 'task_queue' | 'workspace_active' | null = null;
    let activeProfile: string | null = null;
    let profileSource: 'built_in' | 'user' | null = null;
    let runtimeActiveProfile: string | null = null;
    let runtimeProfileSource: 'built_in' | 'user' | null = null;
    const profilesConfigPath = path.join(orchestratorRoot, 'live', 'config', 'profiles.json');
    try {
        if (fs.existsSync(profilesConfigPath) && fs.statSync(profilesConfigPath).isFile()) {
            const resolvedProfile = resolveTaskProfileSelection(orchestratorRoot, rawTaskProfile);
            taskProfile = resolvedProfile.selection.task_profile;
            profileSelectionSource = resolvedProfile.selection.profile_selection_source;
            activeProfile = resolvedProfile.selection.effective_profile;
            profileSource = resolvedProfile.selection.effective_profile_source;
            runtimeActiveProfile = resolvedProfile.selection.runtime_active_profile;
            runtimeProfileSource = resolvedProfile.selection.runtime_profile_source;
        } else if (String(rawTaskProfile || '').trim() && String(rawTaskProfile || '').trim().toLowerCase() !== 'default') {
            throw new Error(
                `Task profile '${String(rawTaskProfile).trim()}' cannot be resolved because profiles config is missing: ${gateHelpers.normalizePath(profilesConfigPath)}`
            );
        }
    } catch (error: unknown) {
        if (String(rawTaskProfile || '').trim() && String(rawTaskProfile || '').trim().toLowerCase() !== 'default') {
            throw error;
        }
    }

    const taskModeArtifact = buildTaskModeArtifact({
        taskId,
        entryMode: options.entryMode,
        requestedDepth: parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', 2),
        effectiveDepth: parseTaskModeDepth(options.effectiveDepth, 'EffectiveDepth', parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', 2)),
        taskSummary: String(options.taskSummary || ''),
        orchestratorWork,
        workflowConfigWork,
        startBanner,
        provider: routingDecision.provider,
        canonicalSourceOfTruth: routingDecision.canonicalSourceOfTruth,
        executionProviderSource: routingDecision.executionProviderSource,
        reviewerCapabilityLevel: routingDecision.provider
            ? resolveReviewerRoutingPolicy(routingDecision.provider).capability_level
            : null,
        reviewerExpectedExecutionMode: routingDecision.provider
            ? resolveReviewerRoutingPolicy(routingDecision.provider).expected_execution_mode
            : null,
        reviewerFallbackAllowed: routingDecision.provider
            ? resolveReviewerRoutingPolicy(routingDecision.provider).fallback_allowed
            : null,
        reviewerFallbackReasonRequired: routingDecision.provider
            ? resolveReviewerRoutingPolicy(routingDecision.provider).fallback_reason_required
            : null,
        reviewerSubagentLaunchStatus: routingDecision.reviewerSubagentLaunchStatus,
        reviewerSubagentLaunchRoute: routingDecision.reviewerSubagentLaunchRoute,
        reviewerSubagentLaunchReason: routingDecision.reviewerSubagentLaunchReason,
        reviewerSubagentLaunchRemediation: routingDecision.reviewerSubagentLaunchRemediation,
        runtimeIdentityStatus: routingDecision.identityStatus,
        runtimeIdentityViolations: routingDecision.violations,
        routedTo: routingDecision.routedTo,
        actor: String(options.actor || 'orchestrator'),
        plan: planMetadata,
        plannedChangedFiles,
        taskProfile,
        profileSelectionSource,
        activeProfile,
        profileSource,
        runtimeActiveProfile,
        runtimeProfileSource,
        dirtyWorkspaceBaseline,
        workflowConfigFileHashes,
        workflowConfigCompatibilityBaselineFiles: workflowConfigPreTaskBaseline.compatibility_baseline_files
    });
    writeJsonArtifact(artifactPath, taskModeArtifact);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: taskModeArtifact.timestamp_utc,
        event_type: 'task_mode_entered',
        status: taskModeArtifact.status,
        task_id: taskModeArtifact.task_id,
        artifact_path: normalizeOptionalPath(artifactPath),
        entry_mode: taskModeArtifact.entry_mode,
        requested_depth: taskModeArtifact.requested_depth,
        effective_depth: taskModeArtifact.effective_depth,
        start_banner: taskModeArtifact.start_banner,
        orchestrator_work: taskModeArtifact.orchestrator_work,
        workflow_config_work: taskModeArtifact.workflow_config_work,
        actor: taskModeArtifact.actor,
        plan_guided: !!taskModeArtifact.plan,
        task_profile: taskModeArtifact.task_profile,
        profile_selection_source: taskModeArtifact.profile_selection_source,
        active_profile: taskModeArtifact.active_profile,
        profile_source: taskModeArtifact.profile_source,
        runtime_active_profile: taskModeArtifact.runtime_active_profile,
        runtime_profile_source: taskModeArtifact.runtime_profile_source,
        dirty_workspace_baseline_count: taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0,
        dirty_workspace_baseline_sha256: taskModeArtifact.dirty_workspace_baseline?.changed_files_sha256 || null,
        workflow_config_file_hash_count: Object.keys(taskModeArtifact.workflow_config_file_hashes || {}).length,
        workflow_config_compatibility_baseline_count: taskModeArtifact.workflow_config_compatibility_baseline_files.length
    }, parseBooleanOption(options.emitMetrics, true));

    try {
        appendMandatoryTaskEvent(
            orchestratorRoot,
            taskModeArtifact.task_id,
            'TASK_MODE_ENTERED',
            'PASS',
            taskModeArtifact.plan
                ? `Task mode entered via ${taskModeArtifact.entry_mode} (plan-guided).`
                : `Task mode entered via ${taskModeArtifact.entry_mode}.`,
            {
                artifact_path: normalizeOptionalPath(artifactPath),
                entry_mode: taskModeArtifact.entry_mode,
                requested_depth: taskModeArtifact.requested_depth,
                effective_depth: taskModeArtifact.effective_depth,
                task_summary: taskModeArtifact.task_summary,
                orchestrator_work: taskModeArtifact.orchestrator_work,
                workflow_config_work: taskModeArtifact.workflow_config_work,
                start_banner: taskModeArtifact.start_banner,
                provider: taskModeArtifact.provider,
                canonical_source_of_truth: taskModeArtifact.canonical_source_of_truth,
                execution_provider_source: taskModeArtifact.execution_provider_source,
                reviewer_capability_level: taskModeArtifact.reviewer_capability_level,
                reviewer_expected_execution_mode: taskModeArtifact.reviewer_expected_execution_mode,
                reviewer_fallback_allowed: taskModeArtifact.reviewer_fallback_allowed,
                reviewer_fallback_reason_required: taskModeArtifact.reviewer_fallback_reason_required,
                reviewer_subagent_launch_status: taskModeArtifact.reviewer_subagent_launch_status,
                reviewer_subagent_launch_route: taskModeArtifact.reviewer_subagent_launch_route,
                reviewer_subagent_launch_reason: taskModeArtifact.reviewer_subagent_launch_reason,
                reviewer_subagent_launch_remediation: taskModeArtifact.reviewer_subagent_launch_remediation,
                runtime_identity_status: taskModeArtifact.runtime_identity_status,
                runtime_identity_violations: taskModeArtifact.runtime_identity_violations,
                routed_to: taskModeArtifact.routed_to,
                actor: taskModeArtifact.actor,
                plan_guided: !!taskModeArtifact.plan,
                plan_path: taskModeArtifact.plan?.plan_path ?? null,
                plan_sha256: taskModeArtifact.plan?.plan_sha256 ?? null,
                task_profile: taskModeArtifact.task_profile,
                profile_selection_source: taskModeArtifact.profile_selection_source,
                active_profile: taskModeArtifact.active_profile,
                profile_source: taskModeArtifact.profile_source,
                runtime_active_profile: taskModeArtifact.runtime_active_profile,
                runtime_profile_source: taskModeArtifact.runtime_profile_source,
                dirty_workspace_baseline_count: taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0,
                dirty_workspace_baseline_sha256: taskModeArtifact.dirty_workspace_baseline?.changed_files_sha256 || null,
                workflow_config_file_hash_count: Object.keys(taskModeArtifact.workflow_config_file_hashes || {}).length,
                workflow_config_compatibility_baseline_count: taskModeArtifact.workflow_config_compatibility_baseline_files.length
            }
        );
    } catch (error: unknown) {
        removeArtifactIfExists(artifactPath);
        throw new Error(
            `enter-task-mode failed because mandatory lifecycle event 'TASK_MODE_ENTERED' could not be appended. ${getErrorMessage(error)}`
        );
    }

    emitPlanCreatedEvent(orchestratorRoot, taskModeArtifact.task_id, {
        artifact_path: normalizeOptionalPath(artifactPath),
        entry_mode: taskModeArtifact.entry_mode,
        requested_depth: taskModeArtifact.requested_depth,
        effective_depth: taskModeArtifact.effective_depth,
        task_summary: taskModeArtifact.task_summary,
        start_banner: taskModeArtifact.start_banner,
        orchestrator_work: taskModeArtifact.orchestrator_work,
        workflow_config_work: taskModeArtifact.workflow_config_work,
        provider: taskModeArtifact.provider,
        canonical_source_of_truth: taskModeArtifact.canonical_source_of_truth,
        execution_provider_source: taskModeArtifact.execution_provider_source,
        runtime_identity_status: taskModeArtifact.runtime_identity_status,
        runtime_identity_violations: taskModeArtifact.runtime_identity_violations,
        routed_to: taskModeArtifact.routed_to,
        plan_guided: !!taskModeArtifact.plan,
        plan_path: taskModeArtifact.plan?.plan_path ?? null,
        plan_sha256: taskModeArtifact.plan?.plan_sha256 ?? null,
        dirty_workspace_baseline_count: taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0,
        dirty_workspace_baseline_sha256: taskModeArtifact.dirty_workspace_baseline?.changed_files_sha256 || null,
        workflow_config_compatibility_baseline_count: taskModeArtifact.workflow_config_compatibility_baseline_files.length
    });

    const previousStatus = readTaskQueueStatus(repoRoot, taskModeArtifact.task_id);
    if (previousStatus && previousStatus !== 'IN_PROGRESS') {
        emitStatusChangedEvent(orchestratorRoot, taskModeArtifact.task_id, previousStatus, 'IN_PROGRESS');
        syncTaskQueueStatus(repoRoot, taskModeArtifact.task_id, 'IN_PROGRESS');
    }

    if (routingDecision.provider && routingDecision.routedTo) {
        emitProviderRoutingEvent(
            orchestratorRoot,
            taskModeArtifact.task_id,
            routingDecision.provider,
            routingDecision.routedTo,
            'task_mode_entry'
        );
    }

    return {
        outputLines: [
            'TASK_MODE_ENTERED',
            `TaskModeArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
            `EntryMode: ${taskModeArtifact.entry_mode}`,
            `RequestedDepth: ${taskModeArtifact.requested_depth}`,
            `EffectiveDepth: ${taskModeArtifact.effective_depth}`,
            ...(taskModeArtifact.start_banner ? [`StartBanner: ${taskModeArtifact.start_banner}`] : []),
            `OrchestratorWork: ${taskModeArtifact.orchestrator_work}`,
            `WorkflowConfigWork: ${taskModeArtifact.workflow_config_work}`,
            ...(routingDecision.provider ? [`Provider: ${routingDecision.provider}`] : []),
            ...(routingDecision.canonicalSourceOfTruth ? [`CanonicalSourceOfTruth: ${routingDecision.canonicalSourceOfTruth}`] : []),
            ...(routingDecision.executionProviderSource ? [`ExecutionProviderSource: ${routingDecision.executionProviderSource}`] : []),
            ...(routingDecision.identityStatus ? [`RuntimeIdentityStatus: ${routingDecision.identityStatus}`] : []),
            ...(routingDecision.routedTo ? [`RoutedTo: ${routingDecision.routedTo}`] : []),
            ...(routingDecision.reviewerSubagentLaunchStatus ? [`ReviewerSubagentLaunchStatus: ${routingDecision.reviewerSubagentLaunchStatus}`] : []),
            ...(routingDecision.reviewerSubagentLaunchRoute ? [`ReviewerSubagentLaunchRoute: ${routingDecision.reviewerSubagentLaunchRoute}`] : []),
            ...(taskModeArtifact.plan ? [`PlanGuided: true`, `PlanPath: ${taskModeArtifact.plan.plan_path}`] : [`PlanGuided: false`]),
            ...(taskModeArtifact.profile_selection_source
                ? [`TaskProfile: ${taskModeArtifact.task_profile || 'default'} (${taskModeArtifact.profile_selection_source})`]
                : []),
            ...(taskModeArtifact.active_profile ? [`ActiveProfile: ${taskModeArtifact.active_profile} (${taskModeArtifact.profile_source || 'unknown'})`] : []),
            ...(taskModeArtifact.runtime_active_profile
                ? [`RuntimeActiveProfile: ${taskModeArtifact.runtime_active_profile} (${taskModeArtifact.runtime_profile_source || 'unknown'})`]
                : []),
            ...(plannedChangedFiles.length > 0 ? [`PlannedChangedFilesCount: ${plannedChangedFiles.length}`] : []),
            ...(protectedPlannedFiles.length > 0 ? [`PlannedProtectedFilesCount: ${protectedPlannedFiles.length}`] : []),
            `DirtyWorkspaceBaselineCount: ${taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0}`,
            `WorkflowConfigCompatibilityBaselineCount: ${taskModeArtifact.workflow_config_compatibility_baseline_files.length}`
        ],
        exitCode: 0
    };
}

export function runLoadRulePackCommand(options: LoadRulePackCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const stage = normalizeRulePackStage(options.stage);
    const artifactPath = resolveRulePackArtifactPath(repoRoot, taskId, String(options.artifactPath || ''));
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage,
        loadedRuleFiles: expandValueList(options.loadedRuleFiles || [], { splitDelimiters: true }),
        preflightPath: String(options.preflightPath || ''),
        taskModePath: String(options.taskModePath || ''),
        actor: String(options.actor || 'orchestrator'),
        artifactPath
    });
    const stageArtifact = stage === 'TASK_ENTRY'
        ? artifact.stages.task_entry
        : artifact.stages.post_preflight;
    if (!stageArtifact) {
        throw new Error(`Rule-pack artifact did not produce stage '${stage}'.`);
    }

    writeJsonArtifact(artifactPath, artifact);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: stageArtifact.timestamp_utc,
        event_type: 'rule_pack_loaded',
        status: stageArtifact.status,
        task_id: taskId,
        stage,
        artifact_path: normalizeOptionalPath(artifactPath),
        preflight_path: stageArtifact.preflight_path,
        required_rule_count: stageArtifact.required_rule_count,
        loaded_rule_count: stageArtifact.loaded_rule_count,
        missing_rule_files: stageArtifact.missing_rule_files,
        actor: stageArtifact.actor
    }, parseBooleanOption(options.emitMetrics, true));

    try {
        appendMandatoryTaskEvent(
            orchestratorRoot,
            taskId,
            stageArtifact.status === 'PASSED' ? 'RULE_PACK_LOADED' : 'RULE_PACK_LOAD_FAILED',
            stageArtifact.outcome,
            stageArtifact.status === 'PASSED'
                ? `Rule pack loaded for ${stage}.`
                : `Rule pack load failed for ${stage}.`,
            {
                stage,
                artifact_path: normalizeOptionalPath(artifactPath),
                preflight_path: stageArtifact.preflight_path,
                required_rule_files: stageArtifact.required_rule_files,
                loaded_rule_files: stageArtifact.loaded_rule_files,
                missing_rule_files: stageArtifact.missing_rule_files,
                effective_depth: stageArtifact.effective_depth,
                required_reviews: stageArtifact.required_reviews,
                actor: stageArtifact.actor
            }
        );
    } catch (error: unknown) {
        removeArtifactIfExists(artifactPath);
        throw new Error(
            `load-rule-pack failed because mandatory lifecycle event '${stageArtifact.status === 'PASSED' ? 'RULE_PACK_LOADED' : 'RULE_PACK_LOAD_FAILED'}' could not be appended. ${getErrorMessage(error)}`
        );
    }

    if (stageArtifact.status !== 'PASSED') {
        const failureLines: string[] = [
            'RULE_PACK_LOAD_FAILED',
            `Stage: ${stage}`,
            `RulePackArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
            'Violations:',
            ...stageArtifact.violations.map(function (item) { return `- ${item}`; })
        ];
        if (stage === 'POST_PREFLIGHT' && stageArtifact.missing_rule_files.length > 0) {
            failureLines.push(
                'Remediation:',
                `  ${buildLoadRulePackPostPreflightRemediationCommand(
                    repoRoot, taskId, stageArtifact.preflight_path, stageArtifact.required_rule_files, String(options.taskModePath || '')
                )}`
            );
        }
        return { outputLines: failureLines, exitCode: EXIT_GATE_FAILURE };
    }

    return {
        outputLines: [
            'RULE_PACK_LOADED',
            `Stage: ${stage}`,
            `RulePackArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
            `RequiredRuleCount: ${stageArtifact.required_rule_count}`,
            `LoadedRuleCount: ${stageArtifact.loaded_rule_count}`
        ],
        exitCode: 0
    };
}

export function runBindRulePackToPreflightCommand(options: BindRulePackToPreflightCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const artifactPath = resolveRulePackArtifactPath(repoRoot, taskId, String(options.artifactPath || ''));
    const preflightPath = String(options.preflightPath || '').trim();
    if (!preflightPath) {
        return {
            outputLines: [
                'RULE_PACK_BIND_FAILED',
                'Stage: POST_PREFLIGHT',
                `RulePackArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
                'Reason: PreflightPath is required for POST_PREFLIGHT rule-pack rebinding.'
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
    const decision = getPostPreflightRulePackRebindDecision(repoRoot, taskId, preflightPath, {
        artifactPath,
        taskModePath: String(options.taskModePath || '')
    });

    if (!decision.can_bind) {
        return {
            outputLines: [
                'RULE_PACK_BIND_FAILED',
                'Stage: POST_PREFLIGHT',
                `RulePackArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
                `Reason: ${decision.reason}`
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }

    const result = runLoadRulePackCommand({
        ...options,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        loadedRuleFiles: decision.loaded_rule_files,
        actor: String(options.actor || 'orchestrator:rule-pack-rebind'),
        artifactPath
    });
    if (result.exitCode !== 0) {
        return result;
    }

    return {
        outputLines: [
            'RULE_PACK_BOUND',
            'Stage: POST_PREFLIGHT',
            `RulePackArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
            `RequiredRuleCount: ${decision.required_rule_files.length}`,
            `ReusedLoadedRuleCount: ${decision.loaded_rule_files.length}`,
            `PreviousPreflightPath: ${decision.previous_preflight_path || '<none>'}`,
            `PreviousRulePackSequence: ${decision.previous_rule_pack_sequence ?? '<none>'}`
        ],
        exitCode: 0
    };
}

export function runRecordNoOpCommand(options: RecordNoOpCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const reason = String(options.reason || '').trim();
    if (!reason) {
        throw new Error('Reason is required.');
    }
    const artifactPath = options.artifactPath
        ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
        : resolveNoOpArtifactPath(repoRoot, taskId, '');
    const preflightPath = String(options.preflightPath || '').trim()
        ? requireResolvedPath(gateHelpers.resolvePathInsideRepo(String(options.preflightPath), repoRoot, { allowMissing: true }), 'PreflightPath')
        : null;

    if (preflightPath) {
        const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const metrics = preflightPayload.metrics && typeof preflightPayload.metrics === 'object' && !Array.isArray(preflightPayload.metrics)
            ? preflightPayload.metrics as Record<string, unknown>
            : null;
        const changedLinesTotal = metrics && typeof metrics.changed_lines_total === 'number'
            ? metrics.changed_lines_total
            : 0;
        const changedFilesCount = Array.isArray(preflightPayload.changed_files) ? preflightPayload.changed_files.length : 0;
        if (changedLinesTotal > 0 || changedFilesCount > 0) {
            throw new Error('No-op artifact is only allowed for zero-diff preflight artifacts.');
        }
    }

    const artifact = buildNoOpArtifact({
        taskId,
        classification: options.classification,
        reason,
        actor: options.actor,
        preflightPath,
        preflightSha256: preflightPath ? gateHelpers.fileSha256(preflightPath) : null
    });
    writeJsonArtifact(artifactPath, artifact);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: artifact.timestamp_utc,
        event_type: 'no_op_recorded',
        task_id: taskId,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        classification: artifact.classification,
        preflight_path: artifact.preflight_path,
        preflight_sha256: artifact.preflight_sha256
    }, parseBooleanOption(options.emitMetrics, true));

    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'NO_OP_RECORDED',
        'INFO',
        'Audited no-op recorded.',
        {
            artifact_path: gateHelpers.normalizePath(artifactPath),
            classification: artifact.classification,
            reason: artifact.reason,
            preflight_path: artifact.preflight_path,
            preflight_sha256: artifact.preflight_sha256
        }
    );

    return {
        outputLines: [
            'NO_OP_RECORDED',
            `TaskId: ${taskId}`,
            `Classification: ${artifact.classification}`,
            `ArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`
        ],
        exitCode: 0
    };
}

export function runHandshakeDiagnosticsCommand(options: HandshakeDiagnosticsCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const routingDecision = readRoutingDecision(
        repoRoot,
        options.provider,
        options.providerBridge,
        taskId,
        options.taskModePath || ''
    );
    const provider = routingDecision.provider;
    const sequenceLockPath = resolvePrePreflightSequenceLockPath(repoRoot, taskId);

    return withFilesystemLock(sequenceLockPath, {}, () => {
        const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
        const shellSmokeEvidence = getShellSmokeEvidence(repoRoot, taskId, { timelinePath });
        const handshakePrecheckViolations = shellSmokeEvidence.evidence_status === 'PASS'
            ? [
                `Current task cycle in '${gateHelpers.normalizePath(timelinePath)}' already has valid SHELL_SMOKE_PREFLIGHT_RECORDED evidence. ` +
                'Re-running handshake-diagnostics now would invalidate the existing shell-smoke artifact for this cycle. ' +
                `Suggested rerun commands for the next cycle: ${buildGateRerunCommand(repoRoot, taskId, 'handshake-diagnostics', String(options.taskModePath || ''))} ; ` +
                `${buildGateRerunCommand(repoRoot, taskId, 'shell-smoke-preflight', String(options.taskModePath || ''))}.`
            ]
            : [];

        const artifactPath = options.artifactPath
            ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
            : resolveHandshakeArtifactPath(repoRoot, taskId, '');

        const artifact = buildHandshakeDiagnostics({
            taskId,
            repoRoot,
            provider,
            canonicalSourceOfTruth: routingDecision.canonicalSourceOfTruth,
            cliPath: options.cliPath ? String(options.cliPath) : undefined,
            effectiveCwd: options.effectiveCwd ? String(options.effectiveCwd) : undefined,
            canonicalEntrypoint: options.canonicalEntrypoint ? String(options.canonicalEntrypoint) : undefined,
            providerBridge: options.providerBridge ? String(options.providerBridge) : undefined,
            routedTo: routingDecision.routedTo,
            executionProviderSource: routingDecision.executionProviderSource,
            reviewerCapabilityLevel: provider
                ? resolveReviewerRoutingPolicy(provider).capability_level
                : null,
            reviewerExpectedExecutionMode: provider
                ? resolveReviewerRoutingPolicy(provider).expected_execution_mode
                : null,
            reviewerFallbackAllowed: provider
                ? resolveReviewerRoutingPolicy(provider).fallback_allowed
                : null,
            reviewerFallbackReasonRequired: provider
                ? resolveReviewerRoutingPolicy(provider).fallback_reason_required
                : null,
            reviewerSubagentLaunchStatus: routingDecision.reviewerSubagentLaunchStatus,
            reviewerSubagentLaunchRoute: routingDecision.reviewerSubagentLaunchRoute,
            reviewerSubagentLaunchReason: routingDecision.reviewerSubagentLaunchReason,
            reviewerSubagentLaunchRemediation: routingDecision.reviewerSubagentLaunchRemediation,
            runtimeIdentityStatus: routingDecision.identityStatus,
            runtimeIdentityViolations: routingDecision.violations,
            precheckViolations: handshakePrecheckViolations
        });

        writeJsonArtifact(artifactPath, artifact);

        const artifactHash = gateHelpers.fileSha256(artifactPath);

        const metricsPath = options.metricsPath
            ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
            : resolveDefaultMetricsPath(repoRoot);
        appendMetricsIfEnabled(repoRoot, metricsPath, {
            timestamp_utc: artifact.timestamp_utc,
            event_type: 'handshake_diagnostics_recorded',
            task_id: taskId,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            artifact_hash: artifactHash,
            provider: artifact.provider,
            execution_context: artifact.execution_context,
            cli_path: artifact.cli_path,
            outcome: artifact.outcome
        }, parseBooleanOption(options.emitMetrics, true));

        emitHandshakeDiagnosticsEvent(
            orchestratorRoot,
            taskId,
            artifact.provider,
            artifact.execution_context,
            artifact.cli_path,
            artifact.outcome === 'PASS',
            artifactHash
        );

        const outputLines = formatHandshakeDiagnosticsResult(artifact);
        outputLines.push(`HandshakeArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);

        return {
            outputLines,
            exitCode: artifact.outcome === 'PASS' ? 0 : EXIT_GATE_FAILURE
        };
    }).result;
}

export function runShellSmokePreflightCommand(options: ShellSmokePreflightCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const routingDecision = readRoutingDecision(
        repoRoot,
        options.provider,
        options.routedTo,
        taskId,
        options.taskModePath || ''
    );
    assertResolvedRuntimeIdentityForDependentPreflightGate(
        repoRoot,
        taskId,
        'shell-smoke-preflight',
        routingDecision,
        String(options.taskModePath || '')
    );
    const provider = routingDecision.provider;

    const sequenceLockPath = resolvePrePreflightSequenceLockPath(repoRoot, taskId);

    return withFilesystemLock(sequenceLockPath, {}, () => {
        const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));

        const artifactPath = options.artifactPath
            ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
            : resolveShellSmokeArtifactPath(repoRoot, taskId, '');

        const probeTimeoutMs = options.probeTimeoutMs ? parseInt(String(options.probeTimeoutMs), 10) : undefined;
        const handshakeEvidence = getHandshakeEvidence(repoRoot, taskId, {
            taskModePath: options.taskModePath || '',
            timelinePath
        });
        const handshakeViolations = getHandshakeEvidenceViolations(handshakeEvidence).map((violation) => (
            `${violation} Suggested rerun commands: ${buildGateRerunCommand(repoRoot, taskId, 'handshake-diagnostics', String(options.taskModePath || ''))} ; ` +
            `${buildGateRerunCommand(repoRoot, taskId, 'shell-smoke-preflight', String(options.taskModePath || ''))}.`
        ));

        const artifact = buildShellSmokePreflight({
            taskId,
            repoRoot,
            provider,
            effectiveCwd: options.effectiveCwd ? String(options.effectiveCwd) : undefined,
            probeTimeoutMs: (probeTimeoutMs && probeTimeoutMs > 0) ? probeTimeoutMs : undefined,
            precheckViolations: handshakeViolations
        });

        writeJsonArtifact(artifactPath, artifact);

        const artifactHash = gateHelpers.fileSha256(artifactPath);

        const metricsPath = options.metricsPath
            ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
            : resolveDefaultMetricsPath(repoRoot);
        appendMetricsIfEnabled(repoRoot, metricsPath, {
            timestamp_utc: artifact.timestamp_utc,
            event_type: 'shell_smoke_preflight_recorded',
            task_id: taskId,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            artifact_hash: artifactHash,
            provider: artifact.provider,
            execution_context: artifact.execution_context,
            outcome: artifact.outcome
        }, parseBooleanOption(options.emitMetrics, true));

        emitShellSmokePreflightEvent(
            orchestratorRoot,
            taskId,
            artifact.provider,
            artifact.execution_context,
            artifact.outcome === 'PASS',
            artifactHash
        );

        const outputLines = formatShellSmokePreflightResult(artifact);
        outputLines.push(`ShellSmokeArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);

        return {
            outputLines,
            exitCode: artifact.outcome === 'PASS' ? 0 : EXIT_GATE_FAILURE
        };
    }).result;
}

export function runCommandTimeoutDiagnosticsCommand(options: CommandTimeoutDiagnosticsCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const routingDecision = readRoutingDecision(
        repoRoot,
        options.provider,
        options.routedTo,
        taskId,
        options.taskModePath || ''
    );
    assertResolvedRuntimeIdentityForDependentPreflightGate(
        repoRoot,
        taskId,
        'command-timeout-diagnostics',
        routingDecision,
        String(options.taskModePath || '')
    );
    const provider = routingDecision.provider;

    const artifactPath = options.artifactPath
        ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
        : resolveCommandTimeoutArtifactPath(repoRoot, taskId, '');

    let commands: CommandPhaseRecord[] = [];
    const commandRecordsPath = options.commandRecordsPath ? String(options.commandRecordsPath).trim() : '';
    if (commandRecordsPath) {
        const resolvedRecordsPath = path.resolve(repoRoot, commandRecordsPath);
        if (fs.existsSync(resolvedRecordsPath) && fs.statSync(resolvedRecordsPath).isFile()) {
            try {
                const raw = JSON.parse(fs.readFileSync(resolvedRecordsPath, 'utf8'));
                if (Array.isArray(raw)) {
                    commands = raw as CommandPhaseRecord[];
                } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).commands)) {
                    commands = (raw as Record<string, unknown>).commands as CommandPhaseRecord[];
                }
            } catch {
                return {
                    outputLines: [`ERROR: Failed to parse command records from '${commandRecordsPath}'.`],
                    exitCode: 3 // EXIT_USAGE_ERROR
                };
            }
        }
    }

    const artifact = buildCommandTimeoutDiagnostics({
        taskId,
        repoRoot,
        provider,
        effectiveCwd: options.effectiveCwd ? String(options.effectiveCwd) : undefined,
        commands
    });

    writeJsonArtifact(artifactPath, artifact);

    const artifactHash = gateHelpers.fileSha256(artifactPath);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: artifact.timestamp_utc,
        event_type: 'command_timeout_diagnostics_recorded',
        task_id: taskId,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        artifact_hash: artifactHash,
        provider: artifact.provider,
        execution_context: artifact.execution_context,
        outcome: artifact.outcome,
        command_count: artifact.commands.length,
        timed_out_count: artifact.commands.filter(c => c.timed_out).length
    }, parseBooleanOption(options.emitMetrics, true));

    emitCommandTimeoutDiagnosticsEvent(
        orchestratorRoot,
        taskId,
        artifact.provider,
        artifact.execution_context,
        artifact.outcome === 'PASS',
        artifact.commands.length,
        artifact.commands.filter(c => c.timed_out).length,
        artifactHash
    );

    const outputLines = formatCommandTimeoutDiagnosticsResult(artifact);
    outputLines.push(`CommandTimeoutArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);

    return {
        outputLines,
        exitCode: artifact.outcome === 'PASS' ? 0 : EXIT_GATE_FAILURE
    };
}
