import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleNameForTarget
} from '../../../core/constants';
import { parseTaskMdTableRow } from '../../../core/task-md-table';
import {
    EXIT_GATE_FAILURE
} from '../../exit-codes';
import {
    DEFAULT_COMPILE_TIMEOUT_MS,
    DEFAULT_GIT_TIMEOUT_MS,
    spawnSyncWithTimeout
} from '../../../core/subprocess';
import { buildOutputTelemetry, formatVisibleSavingsLine } from '../../../gate-runtime/token-telemetry';
import { applyOutputFilterProfile } from '../../../gate-runtime/output-filters';
import {
    emitMandatoryImplementationStartedEventAsync,
    emitMandatoryPreflightFailedEvent,
    emitMandatoryPreflightStartedEvent
} from '../../../gate-runtime/lifecycle-events';
import {
    appendMandatoryTaskEvent,
    appendMandatoryTaskEventAsync,
    assertValidTaskId
} from '../../../gate-runtime/task-events';
import {
    acquireFilesystemLock,
    releaseFilesystemLock
} from '../../../gate-runtime/task-events-locking';
import { auditGateCommand } from '../../../gates/task-events-summary';
import type { CommandCompactnessAudit } from '../../../gates/task-events-summary';
import { buildBudgetForecast, resolveDepthEscalation, resolveRiskAwareDepth } from '../../../gate-runtime/budget-preflight';
import { classifyChange, getClassificationConfig, getReviewCapabilities } from '../../../gates/classify-change';
import { loadReviewExecutionPolicyConfig } from '../../../core/review-execution-policy';
import {
    resolveTaskProfileSelection
} from '../../../policy/task-profile-selection';
import { detectCodeChanged } from '../../../gates/preflight-code-change';
import {
    buildOptionalSkillSelectionArtifact,
    computeOptionalSkillTaskTextSha256,
    getOptionalSkillSelectionGateViolations,
    isOptionalSkillSelectionPolicyConfigured,
    loadOptionalSkillSelectionHeadlinesCache,
    readOptionalSkillSelectionTimelineEvidence,
    readOptionalSkillSelectionPolicyConfig,
    writeOptionalSkillSelectionArtifact
} from '../../../runtime/optional-skill-selection';
import {
    getCompileCommandProfile,
    getCompileCommands,
    getOutputStats,
    getPreflightContext,
    getWorkspaceSnapshot
} from '../../../gates/compile-gate';
import {
    getWorkspaceSnapshotCached
} from '../../../gates/workspace-snapshot-cache';
import { loadIsolationModeConfig } from '../../../gates/isolation-mode';
import { resolveIsolatedOrchestratorRoot, resolveGateExecutionPath } from '../../../gates/isolation-sandbox';
import {
    deriveProtectedDirtyWorkspaceScope,
    detectProtectedDirtyWorkspaceDrift,
    getProtectedDirtyWorkspaceScopeFromPreflight
} from '../../../gates/dirty-worktree-protection';
import {
    assessProtectedManifest
} from '../../../validators/protected-manifest-assessment';
import {
    evaluateProtectedManifestBaselineAllowance,
    getProtectedManifestLifecycleGuard
} from '../../../gates/protected-manifest-guard';
import {
    getTaskModeEvidence,
    getTaskModeEvidenceViolations
} from '../../../gates/task-mode';
import {
    getCurrentWorkflowConfigChanges,
    getWorkflowConfigChangedFiles,
    getWorkflowConfigControlPlanePaths,
    getWorkflowConfigWorkViolations
} from '../../../gates/workflow-config-work';
import {
    readTaskQueueMetadata
} from '../../../gates/task-audit-summary-collectors';
import {
    validateTaskPlan,
    computeTaskPlanDigest,
    isApprovedPlan,
    detectPlanDrift
} from '../../../schemas/task-plan';
import type { PlanDriftResult } from '../../../schemas/task-plan';
import {
    getRulePackEvidence,
    getPostPreflightSequenceEvidence,
    getRulePackEvidenceViolations
} from '../../../gates/rule-pack';
import {
    getHandshakeEvidence,
    getHandshakeEvidenceViolations
} from '../../../gates/handshake-diagnostics';
import {
    getShellSmokeEvidence,
    getShellSmokeEvidenceViolations
} from '../../../gates/shell-smoke-preflight';
import * as gateHelpers from '../../../gates/helpers';
import {
    normalizeOptionalPath,
    removeArtifactIfExists,
    resolveDefaultMetricsPath,
    resolveDefaultReviewsPath,
    resolvePathForWrite,
    resolvePreflightPath,
    writeCompileEvidence,
    writeTextArtifact
} from '../gates-artifacts';
import {
    formatCompileOutputEntry,
    type OutputTelemetrySummary
} from '../gates-formatter';
import {
    expandValueList,
    parseBooleanOption,
    parseIntOption
} from '../gates-parser';
import {
    executeCommandAsync
} from '../gates-subprocess';
import { requireResolvedPath } from '../shared-command-utils';
import {
    getErrorMessage,
    resolveOrchestratorRoot,
    splitOutputLines,
    appendMetricsIfEnabled
} from './gate-flow-helpers';
import { resolveBudgetTokensFromForecast, resolveOutputFiltersPath } from './output-budget-filter';

type ClassificationResult = ReturnType<typeof classifyChange>;
type CompileCommandProfile = ReturnType<typeof getCompileCommandProfile>;
type WorkspaceSnapshot = ReturnType<typeof getWorkspaceSnapshot>;
type PreflightContext = ReturnType<typeof getPreflightContext>;
type CommandPolicyAudit = CommandCompactnessAudit;

export interface ClassifyChangeCommandOptions {
    repoRoot?: string;
    changedFiles?: unknown;
    includeUntracked?: unknown;
    useStaged?: boolean;
    taskIntent?: unknown;
    fastPathMaxFiles?: unknown;
    fastPathMaxChangedLines?: unknown;
    performanceHeuristicMinLines?: unknown;
    taskId?: unknown;
    taskModePath?: string;
    rulePackPath?: string;
    forceAllDomainReviews?: unknown;
    forceCodeReview?: unknown;
    outputPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface CompileGateCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    taskModePath?: string;
    rulePackPath?: string;
    failTailLines?: unknown;
    metricsPath?: string;
    outputFiltersPath?: string;
    compileEvidencePath?: string;
    compileOutputPath?: string;
    commandsPath?: string;
    preflightPath?: string;
    emitMetrics?: unknown;
    allowPlanDrift?: unknown;
    allowPlanDriftReason?: string;
}

function buildNextStepRecoveryCommand(repoRoot: string, taskId: string): string {
    const resolvedRepoRoot = path.resolve(repoRoot || '.');
    const cliPrefix = fs.existsSync(path.join(resolvedRepoRoot, 'bin', 'garda.js'))
        ? 'node bin/garda.js'
        : `node ${resolveBundleNameForTarget(resolvedRepoRoot)}/bin/garda.js`;
    return `${cliPrefix} next-step "${taskId}" --repo-root "."`;
}

function appendNextStepRecoveryHint(message: string, repoRoot: string, taskId: string): string {
    const trimmed = String(message || '').trim();
    if (!trimmed || !taskId || /\bnext-step\b/.test(trimmed)) {
        return trimmed;
    }
    return `${trimmed} NextStep: run ${buildNextStepRecoveryCommand(repoRoot, taskId)} and follow its single recommended command before retrying compile-gate.`;
}

function hasArrayEntries(value: unknown): boolean {
    return Array.isArray(value) && value.length > 0;
}

function buildDomainReviewSurface(triggers: Record<string, unknown>): Record<string, boolean> {
    return {
        db: triggers.db === true || hasArrayEntries(triggers.db_project_evidence),
        security: triggers.security === true,
        api: triggers.api === true,
        performance: triggers.performance === true,
        infra: triggers.infra === true,
        dependency: triggers.dependency === true
    };
}

function isZeroDiffBaselineOnlyNoReviewableScope(
    result: ClassificationResult,
    domainSurface: Record<string, boolean>,
    plannedChangedFiles: string[],
    dirtyWorkspaceBaselineChangedFiles: string[]
): boolean {
    const metrics = result.metrics as Record<string, unknown>;
    const triggers = result.triggers as Record<string, unknown>;
    const zeroDiffGuard = result.zero_diff_guard as Record<string, unknown> | undefined;

    return result.detection_source === 'git_auto'
        && result.scope_category === 'empty'
        && Array.isArray(result.changed_files)
        && result.changed_files.length === 0
        && plannedChangedFiles.length === 0
        && dirtyWorkspaceBaselineChangedFiles.length === 0
        && Number(metrics.changed_files_count || 0) === 0
        && Number(metrics.changed_lines_total || 0) === 0
        && zeroDiffGuard?.zero_diff_detected === true
        && zeroDiffGuard?.status === 'BASELINE_ONLY'
        && zeroDiffGuard?.completion_requires_audited_no_op === true
        && triggers.protected_control_plane_changed !== true
        && !Object.values(domainSurface).some((value) => value === true);
}

function getClassificationRenameCount(repoRoot: string, detectionSource: string, changedFiles: string[]): number {
    if (detectionSource === 'explicit_changed_files' && changedFiles.length === 0) {
        return 0;
    }

    const args = ['-C', repoRoot, 'diff', '--name-status', '--diff-filter=ACDMRTUXB'];
    if (detectionSource === 'git_staged_only' || detectionSource === 'git_staged_plus_untracked') {
        args.push('--cached');
    } else {
        args.push('HEAD');
    }
    if (detectionSource === 'explicit_changed_files' && changedFiles.length > 0) {
        args.push('--', ...changedFiles);
    }

    const result = spawnSyncWithTimeout('git', args, {
        cwd: repoRoot,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS
    });
    if (result.error || result.status !== 0) {
        return 0;
    }

    return splitOutputLines(result.stdout).filter((line) => /^R\d*\t/i.test(line)).length;
}

function getTaskModeEntryTimestampMs(taskModeEvidencePath: string | null): number | null {
    const resolvedPath = String(taskModeEvidencePath || '').trim();
    if (!resolvedPath || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
        const timestampUtc = String(parsed.timestamp_utc || '').trim();
        const parsedTimestamp = Date.parse(timestampUtc);
        if (Number.isFinite(parsedTimestamp)) {
            return parsedTimestamp;
        }
    } catch {
        // Fall back to file mtime below.
    }

    return fs.statSync(resolvedPath).mtimeMs;
}

function readCurrentTaskSummary(repoRoot: string, taskId: string, fallbackTaskSummary: string | null): string | null {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (fs.existsSync(taskPath) && fs.statSync(taskPath).isFile()) {
        for (const line of fs.readFileSync(taskPath, 'utf8').split('\n')) {
            const cells = parseTaskMdTableRow(line);
            if (cells.length >= 5 && cells[0]?.trimmed === taskId) {
                return cells[4]?.trimmed || fallbackTaskSummary;
            }
        }
    }
    return null;
}

function resolveOptionalSkillTaskText(
    repoRoot: string,
    taskId: string,
    taskIntent: unknown,
    fallbackTaskSummary: string | null
): string {
    const explicitTaskIntent = String(taskIntent || '').trim();
    if (explicitTaskIntent) {
        return explicitTaskIntent;
    }
    return String(readCurrentTaskSummary(repoRoot, taskId, fallbackTaskSummary) || '').trim();
}

function listChangedFilesPredatingTaskMode(
    repoRoot: string,
    changedFiles: string[],
    taskModeEvidencePath: string | null
): string[] {
    const taskModeTimestampMs = getTaskModeEntryTimestampMs(taskModeEvidencePath);
    if (taskModeTimestampMs == null || changedFiles.length === 0) {
        return [];
    }

    // Allow for coarse filesystem timestamp resolution.
    const cutoffTimestampMs = taskModeTimestampMs - 1000;
    const preTaskFiles = new Set<string>();
    for (const relativePath of changedFiles) {
        const absolutePath = path.join(repoRoot, relativePath);
        try {
            if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
                continue;
            }
            if (fs.statSync(absolutePath).mtimeMs < cutoffTimestampMs) {
                preTaskFiles.add(relativePath);
            }
        } catch {
            // Ignore unreadable files and let later scope validation surface them if needed.
        }
    }

    return [...preTaskFiles].sort();
}

function resolvePrePreflightSequenceLockPath(repoRoot: string, taskId: string): string {
    return gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'task-events', `${taskId}-pre-preflight-sequence.lock`)
    );
}

function resolveClassifyChangeOutputPath(
    repoRoot: string,
    taskId: string | null,
    explicitOutputPath: string | undefined
): string | null {
    const trimmedOutputPath = String(explicitOutputPath || '').trim();
    if (trimmedOutputPath) {
        return resolvePathForWrite(trimmedOutputPath, repoRoot);
    }
    if (taskId) {
        return resolveDefaultReviewsPath(repoRoot, `${taskId}-preflight.json`);
    }
    return null;
}

function quotePowerShellCliValue(value: string): string {
    return `"${String(value).replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '`"')}"`;
}

function getDistGeneratedSourceCandidates(filePath: string): string[] {
    const normalized = gateHelpers.normalizePath(filePath);
    const distPayload = normalized.startsWith('dist/')
        ? normalized.slice('dist/'.length)
        : (() => {
            const marker = '/dist/';
            const markerIndex = normalized.indexOf(marker);
            return markerIndex >= 0
                ? `${normalized.slice(0, markerIndex + 1)}${normalized.slice(markerIndex + marker.length)}`
                : '';
        })();
    if (!distPayload) {
        return [];
    }
    const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts'];
    if (distPayload.endsWith('.d.ts')) {
        const base = distPayload.slice(0, -'.d.ts'.length);
        return sourceExtensions.map((extension) => `${base}${extension}`);
    }
    const generatedExtensions = ['.js', '.jsx', '.mjs', '.cjs'];
    const generatedExtension = generatedExtensions.find((extension) => distPayload.endsWith(extension));
    if (!generatedExtension) {
        return [];
    }
    const base = distPayload.slice(0, -generatedExtension.length);
    return sourceExtensions.map((extension) => `${base}${extension}`);
}

function getTaskOwnedManifestChangedFiles(taskScopeFiles: string[], manifestChangedFiles: string[]): string[] {
    const normalizedTaskScope = new Set(
        taskScopeFiles
            .map((entry) => gateHelpers.normalizePath(entry))
            .filter(Boolean)
    );
    const relevantManifestFiles = new Set<string>();
    for (const manifestFile of manifestChangedFiles) {
        const normalizedManifestFile = gateHelpers.normalizePath(manifestFile);
        if (!normalizedManifestFile) {
            continue;
        }
        if (normalizedTaskScope.has(normalizedManifestFile)) {
            relevantManifestFiles.add(normalizedManifestFile);
            continue;
        }
        if (getDistGeneratedSourceCandidates(normalizedManifestFile).some((candidate) => normalizedTaskScope.has(candidate))) {
            relevantManifestFiles.add(normalizedManifestFile);
        }
    }
    return [...relevantManifestFiles].sort();
}

function getNewManifestChangedFiles(
    beforeManifestChangedFiles: string[],
    afterManifestChangedFiles: string[]
): string[] {
    const before = new Set(
        beforeManifestChangedFiles
            .map((entry) => gateHelpers.normalizePath(entry))
            .filter(Boolean)
    );
    return [...new Set(
        afterManifestChangedFiles
            .map((entry) => gateHelpers.normalizePath(entry))
            .filter((entry) => entry && !before.has(entry))
    )].sort();
}

function buildClassifyChangeOrchestratorWorkRestartCommand(params: {
    repoRoot: string;
    taskId: string;
    taskModeEvidence: ReturnType<typeof getTaskModeEvidence>;
    taskSummary: string | null;
    changedFiles: string[];
}): string {
    const cliPrefix = gateHelpers.isOrchestratorSourceCheckout(params.repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(params.repoRoot));
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(params.repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(params.taskId)}`,
        `--entry-mode ${quotePowerShellCliValue(params.taskModeEvidence.entry_mode || 'EXPLICIT_TASK_EXECUTION')}`,
        `--requested-depth ${quotePowerShellCliValue(String(params.taskModeEvidence.requested_depth || 2))}`,
        `--task-summary ${quotePowerShellCliValue(params.taskSummary || params.taskModeEvidence.task_summary || '')}`,
        '--orchestrator-work'
    ];
    const includeWorkflowConfigWork = params.taskModeEvidence.workflow_config_work === true
        || getWorkflowConfigChangedFiles([
            ...(params.taskModeEvidence.planned_changed_files || []),
            ...params.changedFiles
        ], getWorkflowConfigControlPlanePaths(params.repoRoot)).length > 0;
    if (includeWorkflowConfigWork) {
        parts.push('--workflow-config-work');
    }
    if (params.taskModeEvidence.start_banner) {
        parts.push(`--start-banner ${quotePowerShellCliValue(params.taskModeEvidence.start_banner)}`);
    }
    if (params.taskModeEvidence.effective_depth) {
        parts.push(`--effective-depth ${quotePowerShellCliValue(String(params.taskModeEvidence.effective_depth))}`);
    }
    if (params.taskModeEvidence.provider) {
        parts.push(`--provider ${quotePowerShellCliValue(params.taskModeEvidence.provider)}`);
    }
    if (params.taskModeEvidence.routed_to) {
        parts.push(`--routed-to ${quotePowerShellCliValue(params.taskModeEvidence.routed_to)}`);
    }
    const plannedFiles = new Set<string>();
    for (const plannedFile of params.taskModeEvidence.planned_changed_files || []) {
        const normalized = gateHelpers.normalizePath(plannedFile);
        if (normalized) {
            plannedFiles.add(normalized);
        }
    }
    for (const changedFile of params.changedFiles) {
        const normalized = gateHelpers.normalizePath(changedFile);
        if (normalized) {
            plannedFiles.add(normalized);
        }
    }
    for (const plannedFile of [...plannedFiles].sort()) {
        parts.push(`--planned-changed-file ${quotePowerShellCliValue(plannedFile)}`);
    }
    return parts.join(' ');
}

function getChangedProtectedFiles(result: ClassificationResult): string[] {
    const rawValue = (result.triggers as Record<string, unknown>).changed_protected_files;
    if (!Array.isArray(rawValue)) {
        return [];
    }
    return rawValue
        .map((entry) => gateHelpers.normalizePath(entry))
        .filter((entry) => entry.length > 0);
}

function mergePathLists(...pathLists: string[][]): string[] {
    return [...new Set(pathLists.flat().map((entry) => gateHelpers.normalizePath(entry)).filter(Boolean))].sort();
}

export function runClassifyChangeCommand(options: ClassifyChangeCommandOptions): { outputText: string } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const resolvedTaskId = gateHelpers.resolveTaskId(options.taskId || '', options.outputPath || '');
    const resolvedTaskModePath = String(options.taskModePath || '');
    if (resolvedTaskId) {
        assertValidTaskId(resolvedTaskId);
        const includeUntrackedForStart = parseBooleanOption(options.includeUntracked, options.useStaged ? false : true);
        emitMandatoryPreflightStartedEvent(orchestratorRoot, resolvedTaskId, {
            task_intent: String(options.taskIntent || ''),
            include_untracked: includeUntrackedForStart,
            use_staged: options.useStaged === true
        });
    }

    let prePreflightSequenceLockHandle: ReturnType<typeof acquireFilesystemLock>['handle'] | null = null;
    try {
    const explicitChangedFilesProvided = options.changedFiles !== undefined;
    const explicitChangedFiles = expandValueList(options.changedFiles, { splitDelimiters: true });
    const includeUntracked = parseBooleanOption(options.includeUntracked, options.useStaged ? false : true);
    const detectionSource = explicitChangedFilesProvided
        ? 'explicit_changed_files'
        : (options.useStaged ? (includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only') : 'git_auto');
    const workspaceSnapshot = getWorkspaceSnapshotCached(repoRoot, detectionSource, includeUntracked, explicitChangedFiles);
    const renameCount = getClassificationRenameCount(
        repoRoot,
        workspaceSnapshot.detection_source,
        workspaceSnapshot.changed_files
    );
    const classificationConfig = getClassificationConfig(repoRoot);
    const reviewCapabilities = getReviewCapabilities(repoRoot);
    const reviewExecutionPolicy = loadReviewExecutionPolicyConfig(repoRoot);
    const result: ClassificationResult & { task_id?: string } = classifyChange({
        normalizedFiles: workspaceSnapshot.changed_files,
        repoRoot,
        taskIntent: String(options.taskIntent || ''),
        fastPathMaxFiles: parseIntOption(options.fastPathMaxFiles, 2, 1),
        fastPathMaxChangedLines: parseIntOption(options.fastPathMaxChangedLines, 40, 1),
        performanceHeuristicMinLines: parseIntOption(options.performanceHeuristicMinLines, 120, 1),
        changedLinesTotal: workspaceSnapshot.changed_lines_total,
        additionsTotal: workspaceSnapshot.additions_total,
        deletionsTotal: workspaceSnapshot.deletions_total,
        renameCount,
        detectionSource: workspaceSnapshot.detection_source,
        classificationConfig,
        reviewCapabilities,
        reviewExecutionPolicyMode: reviewExecutionPolicy.mode
    });
    (result.metrics as Record<string, unknown>).changed_files_sha256 = workspaceSnapshot.changed_files_sha256;
    (result.metrics as Record<string, unknown>).scope_content_sha256 = workspaceSnapshot.scope_content_sha256;
    (result.metrics as Record<string, unknown>).scope_sha256 = workspaceSnapshot.scope_sha256;

    const protectedFilesSnapshot = gateHelpers.scanProtectedPathHashes(
        repoRoot,
        gateHelpers.getProtectedControlPlaneRoots(repoRoot)
    );
    const protectedFilesSnapshotSha256 = gateHelpers.computeProtectedSnapshotDigest(protectedFilesSnapshot);
    const protectedManifestEvidence = gateHelpers.evaluateProtectedControlPlaneManifest(
        repoRoot,
        protectedFilesSnapshot
    );
    (result.triggers as any).protected_control_plane_snapshot_sha256 = protectedFilesSnapshotSha256;
    (result.triggers as any).protected_control_plane_manifest_status = protectedManifestEvidence.status;
    (result.triggers as any).protected_control_plane_manifest_path = protectedManifestEvidence.manifest_path;
    (result.triggers as any).protected_control_plane_manifest_changed_files = protectedManifestEvidence.changed_files;
    let protectedManifestAssessment = assessProtectedManifest({
        evidence: protectedManifestEvidence
    });

    const isolationConfig = loadIsolationModeConfig(repoRoot);
    (result.triggers as any).isolation_mode_enabled = isolationConfig.enabled;
    (result.triggers as any).isolation_mode_enforcement = isolationConfig.enforcement;
    (result.triggers as any).isolation_mode_use_sandbox = isolationConfig.use_sandbox;

    const sandboxResolution = resolveIsolatedOrchestratorRoot(repoRoot);
    (result.triggers as any).isolation_sandbox_active = sandboxResolution.using_sandbox;
    (result.triggers as any).isolation_sandbox_resolved_root = gateHelpers.normalizePath(sandboxResolution.resolved_root);
    (result.triggers as any).isolation_sandbox_reason = sandboxResolution.reason;

    let isolationViolationMessage: string | null = null;
    if (isolationConfig.enabled && isolationConfig.require_manifest_match_before_task) {
        if (protectedManifestEvidence.status === 'MISSING') {
            const msg = 'Control-plane isolation requires a trusted manifest, but none was found. Run setup/update/reinit to generate one.';
            if (isolationConfig.enforcement === 'STRICT') {
                isolationViolationMessage = msg;
            }
            (result.triggers as any).isolation_mode_pre_task_warning = msg;
        } else if (protectedManifestEvidence.status === 'INVALID') {
            const msg = `Trusted control-plane manifest at '${gateHelpers.normalizePath(protectedManifestEvidence.manifest_path)}' is malformed. Re-run setup/update/reinit.`;
            if (isolationConfig.enforcement === 'STRICT') {
                isolationViolationMessage = msg;
            }
            (result.triggers as any).isolation_mode_pre_task_warning = msg;
        } else if (protectedManifestEvidence.status === 'DRIFT' && isolationConfig.refuse_on_preflight_drift) {
            const msg = `Control-plane isolation detected drift in ${protectedManifestEvidence.changed_files.length} file(s) before task start: ${protectedManifestEvidence.changed_files.join(', ')}. Refresh the trusted manifest or disable isolation mode.`;
            if (isolationConfig.enforcement === 'STRICT') {
                isolationViolationMessage = msg;
            }
            (result.triggers as any).isolation_mode_pre_task_warning = msg;
        }
    }
    if (isolationViolationMessage) {
        (result as any).isolation_mode_violation = isolationViolationMessage;
    }

    let currentTaskSummary: string | null = null;
    let effectiveTaskPolicy: ReturnType<typeof resolveTaskProfileSelection>['effective_policy'] | null = null;
    if (resolvedTaskId) {
        prePreflightSequenceLockHandle = acquireFilesystemLock(
            resolvePrePreflightSequenceLockPath(repoRoot, resolvedTaskId),
            {}
        ).handle;
        result.task_id = resolvedTaskId;

        const preflightErrors: string[] = [];
        const taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, resolvedTaskModePath);
        const taskQueueMetadata = readTaskQueueMetadata(repoRoot, resolvedTaskId);
        currentTaskSummary = readCurrentTaskSummary(repoRoot, resolvedTaskId, taskModeEvidence.task_summary);
        const rawTaskProfile = taskModeEvidence.task_profile || taskQueueMetadata?.profile || null;
        const profilesConfigPath = path.join(orchestratorRoot, 'live', 'config', 'profiles.json');
        if (fs.existsSync(profilesConfigPath) && fs.statSync(profilesConfigPath).isFile()) {
            try {
                const domainSurface = buildDomainReviewSurface(result.triggers as Record<string, unknown>);
                const resolvedProfile = resolveTaskProfileSelection(
                    orchestratorRoot,
                    rawTaskProfile,
                    typeof result.scope_category === 'string' ? result.scope_category : null,
                    {
                        domainSurface,
                        forceAllDomainReviews: parseBooleanOption(options.forceAllDomainReviews, false),
                        forceCodeReview: parseBooleanOption(options.forceCodeReview, false),
                        protectedControlPlaneChanged: (result.triggers as Record<string, unknown>).protected_control_plane_changed === true,
                        zeroDiffBaselineOnly: isZeroDiffBaselineOnlyNoReviewableScope(
                            result,
                            domainSurface,
                            taskModeEvidence.planned_changed_files || [],
                            taskModeEvidence.dirty_workspace_baseline?.changed_files || []
                        )
                    }
                );
                effectiveTaskPolicy = resolvedProfile.effective_policy;
                (result as Record<string, unknown>).profile_selection = resolvedProfile.selection;
                (result as Record<string, unknown>).profile_guardrails = effectiveTaskPolicy.guardrail_diagnostics;

                const guardrailDecisions = new Map(
                    (effectiveTaskPolicy.guardrail_diagnostics?.decisions || []).map((decision) => [decision.review_type, decision])
                );
                for (const [reviewType, currentValue] of Object.entries(result.required_reviews)) {
                    const guardrailDecision = guardrailDecisions.get(reviewType);
                    if (guardrailDecision?.decision === 'zero_diff_no_reviewable_scope') {
                        (result.required_reviews as Record<string, boolean>)[reviewType] = false;
                    } else if (currentValue === true) {
                        (result.required_reviews as Record<string, boolean>)[reviewType] = true;
                    } else if (
                        guardrailDecision?.effective_value === true
                        && (
                            guardrailDecision.profile_wanted === true
                            || guardrailDecision.decision === 'profile_forced'
                        )
                    ) {
                        (result.required_reviews as Record<string, boolean>)[reviewType] = true;
                    } else {
                        (result.required_reviews as Record<string, boolean>)[reviewType] = false;
                    }
                }
            } catch (error: unknown) {
                preflightErrors.push(error instanceof Error ? error.message : String(error));
            }
        } else if (String(rawTaskProfile || '').trim() && String(rawTaskProfile || '').trim().toLowerCase() !== 'default') {
            preflightErrors.push(
                `Task profile '${String(rawTaskProfile).trim()}' cannot be resolved because profiles config is missing: ${gateHelpers.normalizePath(profilesConfigPath)}`
            );
        }
        const dirtyWorkspaceBaseline = taskModeEvidence.dirty_workspace_baseline;
        const dirtyWorkspaceProtectedScope = deriveProtectedDirtyWorkspaceScope(
            dirtyWorkspaceBaseline,
            workspaceSnapshot.changed_files
        );
        const dirtyWorkspaceProtectionDrift = detectProtectedDirtyWorkspaceDrift(
            repoRoot,
            dirtyWorkspaceProtectedScope
        );
        preflightErrors.push(...getTaskModeEvidenceViolations(taskModeEvidence));
        const workflowConfigChanges = getCurrentWorkflowConfigChanges(
            repoRoot,
            taskModeEvidence.workflow_config_file_hashes
        );
        const changedWorkflowConfigFiles = mergePathLists(
            workflowConfigChanges.changed_files,
            taskModeEvidence.workflow_config_file_hashes
                ? []
                : getWorkflowConfigChangedFiles(result.changed_files, getWorkflowConfigControlPlanePaths(repoRoot))
        );
        (result.triggers as any).changed_workflow_config_files = changedWorkflowConfigFiles;
        (result.triggers as any).workflow_config_file_hashes = workflowConfigChanges.current_file_hashes;
        if (workflowConfigChanges.scan_error) {
            (result.triggers as any).workflow_config_workspace_scan_error = workflowConfigChanges.scan_error;
        }
        const changedProtectedFiles = mergePathLists(getChangedProtectedFiles(result), changedWorkflowConfigFiles);
        if (changedProtectedFiles.length > 0) {
            (result.triggers as any).changed_protected_files = changedProtectedFiles;
            (result.triggers as any).protected_control_plane_changed = true;
        }
        if (preflightErrors.length === 0) {
            preflightErrors.push(...getWorkflowConfigWorkViolations({
                changedFiles: changedWorkflowConfigFiles,
                taskModeEvidence,
                phaseLabel: 'preflight classification',
                baselineFileHashes: taskModeEvidence.workflow_config_file_hashes,
                currentFileHashes: workflowConfigChanges.current_file_hashes
            }));
        }
        if (
            preflightErrors.length === 0
            && changedProtectedFiles.length > 0
            && taskModeEvidence.orchestrator_work !== true
        ) {
            preflightErrors.push(
                `Preflight scope touches protected orchestrator control-plane files without task-mode --orchestrator-work: ${changedProtectedFiles.join(', ')}. ` +
                'Restart task mode as orchestrator work before preflight classification. ' +
                `Suggested command: ${buildClassifyChangeOrchestratorWorkRestartCommand({
                    repoRoot,
                    taskId: resolvedTaskId,
                    taskModeEvidence,
                    taskSummary: currentTaskSummary,
                    changedFiles: workspaceSnapshot.changed_files
                })}`
            );
        }

        if (dirtyWorkspaceBaseline) {
            (result.triggers as any).dirty_workspace_baseline_changed_files = dirtyWorkspaceBaseline.changed_files;
            (result.triggers as any).dirty_workspace_baseline_changed_files_sha256 = dirtyWorkspaceBaseline.changed_files_sha256;
            (result.triggers as any).dirty_workspace_protected_files = dirtyWorkspaceProtectedScope?.protected_files || [];
            (result.triggers as any).dirty_workspace_protected_files_sha256 =
                dirtyWorkspaceProtectedScope?.protected_files_sha256 || null;
            (result.triggers as any).dirty_workspace_protected_file_hashes =
                dirtyWorkspaceProtectedScope?.protected_file_hashes || {};
            (result.triggers as any).dirty_workspace_protection_status = dirtyWorkspaceProtectionDrift.status;
            (result.triggers as any).dirty_workspace_protection_changed_files = dirtyWorkspaceProtectionDrift.changed_files;
        }
        const protectedManifestBaselineAllowance = evaluateProtectedManifestBaselineAllowance({
            orchestratorWork: taskModeEvidence.orchestrator_work === true,
            manifestStatus: protectedManifestEvidence.status,
            manifestChangedFiles: protectedManifestEvidence.changed_files,
            dirtyWorkspaceProtectionStatus: dirtyWorkspaceProtectionDrift.status,
            dirtyWorkspaceProtectedFiles: dirtyWorkspaceProtectedScope?.protected_files || []
        });
        (result.triggers as any).protected_control_plane_manifest_baseline_allowance_status =
            protectedManifestBaselineAllowance.status;
        protectedManifestAssessment = assessProtectedManifest({
            evidence: protectedManifestEvidence,
            baselineAllowanceStatus: protectedManifestBaselineAllowance.status,
            orchestratorWork: taskModeEvidence.orchestrator_work === true
        });

        const rulePackEvidence = getRulePackEvidence(repoRoot, resolvedTaskId, 'TASK_ENTRY', {
            artifactPath: String(options.rulePackPath || '')
        });
        preflightErrors.push(...getRulePackEvidenceViolations(rulePackEvidence));

        const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`));
        const timelineErrors: string[] = [];
        const timelineEvidence = readOptionalSkillSelectionTimelineEvidence(orchestratorRoot, resolvedTaskId, timelinePath);
        const timelineEventTypes = timelineEvidence.eventTypes;
        if (!timelineEvidence.exists) {
            timelineErrors.push(`Task timeline not found: ${gateHelpers.normalizePath(timelineEvidence.timelinePath)}`);
        } else if (timelineEvidence.invalidJson) {
            timelineErrors.push(`Task timeline contains invalid JSON line: ${gateHelpers.normalizePath(timelineEvidence.timelinePath)}`);
        }
        preflightErrors.push(...timelineErrors);
        if (timelineErrors.length === 0 && !timelineEventTypes.has('TASK_MODE_ENTERED')) {
            preflightErrors.push(
                `Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing TASK_MODE_ENTERED. Run enter-task-mode before preflight.`
            );
        }
        if (timelineErrors.length === 0 && !timelineEventTypes.has('RULE_PACK_LOADED')) {
            preflightErrors.push(
                `Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing RULE_PACK_LOADED. Run load-rule-pack before preflight.`
            );
        }
        if (timelineErrors.length === 0 && !timelineEventTypes.has('HANDSHAKE_DIAGNOSTICS_RECORDED')) {
            preflightErrors.push(
                `Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing HANDSHAKE_DIAGNOSTICS_RECORDED. Run handshake-diagnostics before preflight.`
            );
        }
        if (timelineErrors.length === 0 && !timelineEventTypes.has('SHELL_SMOKE_PREFLIGHT_RECORDED')) {
            preflightErrors.push(
                `Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing SHELL_SMOKE_PREFLIGHT_RECORDED. Run shell-smoke-preflight before preflight.`
            );
        }
        if (preflightErrors.length === 0) {
            const handshakeEvidence = getHandshakeEvidence(repoRoot, resolvedTaskId, {
                taskModePath: options.taskModePath || '',
                timelinePath
            });
            const shellSmokeEvidence = getShellSmokeEvidence(repoRoot, resolvedTaskId, { timelinePath });
            preflightErrors.push(...getHandshakeEvidenceViolations(handshakeEvidence));
            preflightErrors.push(...getShellSmokeEvidenceViolations(shellSmokeEvidence));
        }
        const hasExplicitScopeIsolation = explicitChangedFilesProvided || options.useStaged === true;
        if (preflightErrors.length === 0 && !hasExplicitScopeIsolation) {
            const preTaskModifiedFiles = dirtyWorkspaceBaseline
                ? dirtyWorkspaceBaseline.changed_files
                : listChangedFilesPredatingTaskMode(
                    repoRoot,
                    workspaceSnapshot.changed_files,
                    taskModeEvidence.evidence_path
                );
            if (preTaskModifiedFiles.length > 0) {
                preflightErrors.push(
                    `Workspace already contained modified files before task-mode entry: ${preTaskModifiedFiles.join(', ')}. ` +
                    'This run is invalid as a normal orchestrated task start because the fresh main-agent start-banner step must happen before any edits. ' +
                    'The start banner is a one-time orchestrator-mode marker, not a file-state claim. ' +
                    'Clean/stash unrelated changes, or rerun classify-change with --use-staged or explicit --changed-file scope after entering task mode.'
                );
            }
        }
        if (preflightErrors.length === 0 && hasExplicitScopeIsolation && dirtyWorkspaceProtectionDrift.status === 'DRIFT_DETECTED') {
            preflightErrors.push(...dirtyWorkspaceProtectionDrift.violations);
        }
        if (preflightErrors.length === 0) {
            const taskOwnedManifestChangedFiles = getTaskOwnedManifestChangedFiles(
                workspaceSnapshot.changed_files,
                protectedManifestEvidence.changed_files
            );
            const classifyManifestRestartHint = taskModeEvidence.orchestrator_work !== true
                ? buildClassifyChangeOrchestratorWorkRestartCommand({
                    repoRoot,
                    taskId: resolvedTaskId,
                    taskModeEvidence,
                    taskSummary: currentTaskSummary,
                    changedFiles: [...workspaceSnapshot.changed_files, ...taskOwnedManifestChangedFiles]
                })
                : undefined;
            const protectedManifestGuard = getProtectedManifestLifecycleGuard({
                repoRoot,
                orchestratorWork: taskModeEvidence.orchestrator_work === true,
                phaseLabel: 'preflight classification',
                manifestEvidence: protectedManifestEvidence,
                dirtyWorkspaceProtectionStatus: dirtyWorkspaceProtectionDrift.status,
                dirtyWorkspaceProtectedFiles: dirtyWorkspaceProtectedScope?.protected_files || [],
                restartCommandHint: classifyManifestRestartHint
            });
            preflightErrors.push(...protectedManifestGuard.violations);
        }
        if (preflightErrors.length > 0) {
            throw new Error(preflightErrors.join(' '));
        }

        if (isolationViolationMessage) {
            throw new Error(`Control-plane isolation (STRICT) blocked preflight: ${isolationViolationMessage}`);
        }
    } else if (isolationViolationMessage) {
        throw new Error(`Control-plane isolation (STRICT) blocked preflight: ${isolationViolationMessage}`);
    }

    (result.triggers as any).protected_control_plane_manifest_assessment =
        protectedManifestAssessment?.code || null;

    if (resolvedTaskId) {
        const taskModeForBudget = getTaskModeEvidence(repoRoot, resolvedTaskId, resolvedTaskModePath);
        const requestedDepth = taskModeForBudget.requested_depth || 2;

        let tokenEconomyEnabled = true;
        let enabledDepths = [1, 2];
        let baseStripExamples = true;
        let baseStripCodeBlocks = true;
        let baseScopedDiffs = true;
        let baseCompactReviewerOutput = true;
        const tokenEconomyPath = resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'token-economy.json'));
        try {
            if (fs.existsSync(tokenEconomyPath)) {
                const teConfig = JSON.parse(fs.readFileSync(tokenEconomyPath, 'utf8')) as Record<string, unknown>;
                if (typeof teConfig.enabled === 'boolean') tokenEconomyEnabled = teConfig.enabled;
                if (Array.isArray(teConfig.enabled_depths)) enabledDepths = teConfig.enabled_depths as number[];
                if (typeof teConfig.strip_examples === 'boolean') baseStripExamples = teConfig.strip_examples;
                if (typeof teConfig.strip_code_blocks === 'boolean') baseStripCodeBlocks = teConfig.strip_code_blocks;
                if (typeof teConfig.scoped_diffs === 'boolean') baseScopedDiffs = teConfig.scoped_diffs;
                if (typeof teConfig.compact_reviewer_output === 'boolean') baseCompactReviewerOutput = teConfig.compact_reviewer_output;
            }
        } catch { /* use defaults */ }

        if (effectiveTaskPolicy) {
            tokenEconomyEnabled = effectiveTaskPolicy.token_economy.enabled;
            enabledDepths = effectiveTaskPolicy.token_economy.enabled_depths;
            baseStripExamples = effectiveTaskPolicy.token_economy.strip_examples;
            baseStripCodeBlocks = effectiveTaskPolicy.token_economy.strip_code_blocks;
            baseScopedDiffs = effectiveTaskPolicy.token_economy.scoped_diffs;
            baseCompactReviewerOutput = effectiveTaskPolicy.token_economy.compact_reviewer_output;
        }

        const riskTriggers = {
            db: !!result.triggers.db,
            security: !!result.triggers.security,
            refactor: !!result.triggers.refactor,
            api: !!result.triggers.api,
            test: !!result.triggers.test,
            performance: !!result.triggers.performance,
            infra: !!result.triggers.infra,
            dependency: !!result.triggers.dependency
        };

        const riskAwareDepth = resolveRiskAwareDepth(
            requestedDepth,
            result.mode,
            riskTriggers,
            {
                strip_examples: baseStripExamples,
                strip_code_blocks: baseStripCodeBlocks,
                scoped_diffs: baseScopedDiffs,
                compact_reviewer_output: baseCompactReviewerOutput
            }
        );

        const effectiveDepth = riskAwareDepth.effective_depth;

        const depthEscalation = resolveDepthEscalation({
            taskId: resolvedTaskId,
            requestedDepth,
            effectiveDepth,
            pathMode: result.mode,
            changedFilesCount: result.metrics.changed_files_count,
            changedLinesTotal: result.metrics.changed_lines_total,
            requiredReviews: result.required_reviews as Record<string, boolean>
        });

        const budgetForecast = buildBudgetForecast({
            taskId: resolvedTaskId,
            requestedDepth,
            effectiveDepth,
            pathMode: result.mode,
            changedFilesCount: result.metrics.changed_files_count,
            changedLinesTotal: result.metrics.changed_lines_total,
            requiredReviews: result.required_reviews as Record<string, boolean>,
            tokenEconomyEnabled,
            tokenEconomyEnabledDepths: enabledDepths
        });

        (result as any).budget_forecast = budgetForecast;
        (result as any).depth_escalation = depthEscalation;
        (result as any).risk_aware_depth = riskAwareDepth;
    }

    const outputPath = resolveClassifyChangeOutputPath(repoRoot, resolvedTaskId || null, options.outputPath);
    let optionalSkillSelectionArtifactPath: string | null = null;
    if (outputPath) {
        let optionalSkillSelectionPreview: ReturnType<typeof buildOptionalSkillSelectionArtifact> | null = null;
        const optionalSkillPolicyEnabled = resolvedTaskId
            ? isOptionalSkillSelectionPolicyConfigured(orchestratorRoot)
            : false;
        const optionalSkillPolicyMode = (resolvedTaskId && optionalSkillPolicyEnabled)
            ? readOptionalSkillSelectionPolicyConfig(orchestratorRoot).mode
            : null;
        const optionalSkillTaskText = resolvedTaskId
            ? resolveOptionalSkillTaskText(repoRoot, resolvedTaskId, options.taskIntent, currentTaskSummary)
            : '';
        if (resolvedTaskId && optionalSkillPolicyEnabled) {
            try {
                (result as Record<string, unknown>).optional_skill_selection = {
                    artifact_path: optionalSkillPolicyMode === 'off'
                        ? null
                        : normalizeOptionalPath(path.join(orchestratorRoot, 'runtime', 'reviews', `${resolvedTaskId}-optional-skill-selection.json`)),
                    policy_mode: optionalSkillPolicyMode,
                    decision: null,
                    visible_summary_line: optionalSkillPolicyMode === 'off'
                        ? 'Optional skills: as_is (reason: policy_off)'
                        : null
                };
                if (optionalSkillPolicyMode !== 'off') {
                    optionalSkillSelectionPreview = buildOptionalSkillSelectionArtifact(
                        orchestratorRoot,
                        resolvedTaskId,
                        {
                            taskText: optionalSkillTaskText,
                            changedPaths: result.changed_files as string[]
                        }
                    );
                    (result as Record<string, unknown>).optional_skill_selection = {
                        artifact_path: normalizeOptionalPath(optionalSkillSelectionPreview.artifactPath),
                        policy_mode: optionalSkillSelectionPreview.payload.policy_mode,
                        decision: optionalSkillSelectionPreview.payload.decision,
                        visible_summary_line: optionalSkillSelectionPreview.payload.visible_summary_line
                    };
                }
            } catch (error: unknown) {
                if (optionalSkillPolicyMode === 'required' || optionalSkillPolicyMode === 'strict') {
                    throw error;
                }
                (result as Record<string, unknown>).optional_skill_selection = {
                    artifact_path: normalizeOptionalPath(path.join(orchestratorRoot, 'runtime', 'reviews', `${resolvedTaskId}-optional-skill-selection.json`)),
                    policy_mode: optionalSkillPolicyMode,
                    decision: null,
                    visible_summary_line: null,
                    warning: error instanceof Error ? error.message : String(error)
                };
            }
        }
        const preflightArtifactText = `${JSON.stringify(result, null, 2)}\n`;
        const preflightSha256 = createHash('sha256').update(preflightArtifactText, 'utf8').digest('hex');
        writeTextArtifact(outputPath, preflightArtifactText);
        if (resolvedTaskId && optionalSkillPolicyEnabled) {
            let optionalSkillSelection;
            try {
                optionalSkillSelection = optionalSkillPolicyMode === 'off'
                    ? null
                    : optionalSkillSelectionPreview
                    ? writeOptionalSkillSelectionArtifact(
                        orchestratorRoot,
                        resolvedTaskId,
                        {
                            taskText: optionalSkillTaskText,
                            changedPaths: result.changed_files as string[],
                            preflightPath: outputPath,
                            preflightSha256,
                            preparedArtifact: optionalSkillSelectionPreview,
                            loadedHeadlinesCache: optionalSkillSelectionPreview.loadedHeadlinesCache || null
                        }
                    )
                    : null;
            } catch (error: unknown) {
                if (optionalSkillPolicyMode !== 'required' && optionalSkillPolicyMode !== 'strict') {
                    optionalSkillSelection = null;
                    (result as Record<string, unknown>).optional_skill_selection = {
                        artifact_path: normalizeOptionalPath(path.join(orchestratorRoot, 'runtime', 'reviews', `${resolvedTaskId}-optional-skill-selection.json`)),
                        policy_mode: optionalSkillPolicyMode,
                        decision: optionalSkillSelectionPreview?.payload.decision || null,
                        visible_summary_line: optionalSkillSelectionPreview?.payload.visible_summary_line || null,
                        warning: error instanceof Error ? error.message : String(error)
                    };
                    writeTextArtifact(outputPath, `${JSON.stringify(result, null, 2)}\n`);
                } else {
                    removeArtifactIfExists(outputPath);
                    throw error;
                }
            }
            if (optionalSkillSelection) {
                optionalSkillSelectionArtifactPath = normalizeOptionalPath(optionalSkillSelection.artifactPath);
            } else if (optionalSkillPolicyMode === 'required' || optionalSkillPolicyMode === 'strict') {
                removeArtifactIfExists(outputPath);
                throw new Error('Optional skill selection artifact is required for the current policy mode, but no current-cycle artifact could be materialized.');
            }
        }
    }

    const metricsPath = options.metricsPath
        ? resolvePathForWrite(options.metricsPath, repoRoot)
        : resolvePathForWrite(classificationConfig.metrics_path, repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: new Date().toISOString(),
        event_type: 'preflight_classification',
        repo_root: gateHelpers.normalizePath(repoRoot),
        task_id: resolvedTaskId || null,
        output_path: normalizeOptionalPath(outputPath),
        result
    }, parseBooleanOption(options.emitMetrics, true));

    if (resolvedTaskId) {
        const codeChanged = detectCodeChanged(result as unknown as Record<string, unknown>, repoRoot);
        try {
            appendMandatoryTaskEvent(
                orchestratorRoot,
                resolvedTaskId,
                'PREFLIGHT_CLASSIFIED',
                'INFO',
                result.zero_diff_guard && result.zero_diff_guard.zero_diff_detected
                    ? `Preflight completed with mode ${result.mode} (zero-diff baseline only).`
                    : `Preflight completed with mode ${result.mode}.`,
                {
                    mode: result.mode,
                    output_path: normalizeOptionalPath(outputPath),
                    changed_files_count: result.metrics.changed_files_count,
                    changed_lines_total: result.metrics.changed_lines_total,
                    scope_sha256: (result.metrics as Record<string, unknown>).scope_sha256,
                    scope_content_sha256: (result.metrics as Record<string, unknown>).scope_content_sha256,
                    code_changed: codeChanged,
                    required_reviews: result.required_reviews,
                    review_execution_policy: (result as Record<string, unknown>).review_execution_policy ?? null,
                    profile_selection: (result as Record<string, unknown>).profile_selection ?? null,
                    profile_guardrails: (result as Record<string, unknown>).profile_guardrails ?? null,
                    optional_skill_selection_artifact_path: optionalSkillSelectionArtifactPath,
                    zero_diff_guard: result.zero_diff_guard,
                    budget_forecast: (result as any).budget_forecast || null,
                    depth_escalation: (result as any).depth_escalation || null
                }
            );
        } catch (error: unknown) {
            removeArtifactIfExists(outputPath);
            throw new Error(
                `classify-change failed because mandatory lifecycle event 'PREFLIGHT_CLASSIFIED' could not be appended. ${getErrorMessage(error)}`
            );
        }
    }

    return {
        outputText: `${JSON.stringify(result, null, 2)}\n`
    };
    } catch (error: unknown) {
        if (resolvedTaskId) {
            try {
                emitMandatoryPreflightFailedEvent(orchestratorRoot, resolvedTaskId, {
                    error: getErrorMessage(error),
                    task_intent: String(options.taskIntent || '')
                });
            } catch (eventError: unknown) {
                throw new Error(
                    `classify-change failed and mandatory lifecycle event 'PREFLIGHT_FAILED' could not be appended. Original error: ${getErrorMessage(error)} | Event append error: ${getErrorMessage(eventError)}`
                );
            }
        }
        throw error;
    } finally {
        releaseFilesystemLock(prePreflightSequenceLockHandle);
    }
}

export async function runCompileGateCommand(options: CompileGateCommandOptions): Promise<{ outputLines: string[]; exitCode: number }> {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const resolvedTaskId = assertValidTaskId(String(options.taskId || '').trim());
    const failTailLines = parseIntOption(options.failTailLines, 50, 1);
    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    const outputFiltersPath = resolveOutputFiltersPath(repoRoot, options.outputFiltersPath || '');
    const compileEvidencePath = options.compileEvidencePath
        ? requireResolvedPath(resolvePathForWrite(options.compileEvidencePath, repoRoot), 'CompileEvidencePath')
        : resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`);
    const compileOutputPath = options.compileOutputPath
        ? requireResolvedPath(resolvePathForWrite(options.compileOutputPath, repoRoot), 'CompileOutputPath')
        : resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-output.log`);

    let resolvedCommandsPath: string | null = null;
    let compileCommands: string[] = [];
    let resolvedPreflightPath: string | null = null;
    let preflightHash: string | null = null;
    let preflightContext: PreflightContext | null = null;
    let workspaceSnapshot: WorkspaceSnapshot | null = null;
    let taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
    let rulePackEvidence = getRulePackEvidence(repoRoot, resolvedTaskId, 'TASK_ENTRY', {
        artifactPath: String(options.rulePackPath || '')
    });
    let warningCount = 0;
    let errorCount = 0;
    let exitCode = 0;
    let exceptionMessage: string | null = null;
    let selectedCommandProfile: CompileCommandProfile | null = null;
    let selectedCommandIndex = 0;
    let budgetTokensForOutputFilters: number | null = null;
    const compileOutputLines: string[] = [];
    const compileOutputChunks: string[] = [];
    const compileCommandAudits: CommandPolicyAudit[] = [];
    const startedAt = Date.now();
    let compileOutputInitialized = false;
    let planDriftResult: PlanDriftResult | null = null;
    let dirtyWorkspaceProtectionDrift = detectProtectedDirtyWorkspaceDrift(repoRoot, null);
    let protectedManifestGuard: ReturnType<typeof getProtectedManifestLifecycleGuard> | null = null;
    let postPreflightSequenceEvidence: ReturnType<typeof getPostPreflightSequenceEvidence> | null = null;
    let workflowConfigBaselineForCompile: Record<string, string | null> | null = null;

    try {
        const commandsPathValue = options.commandsPath
            ? options.commandsPath
            : resolveGateExecutionPath(repoRoot, path.join('live', 'docs', 'agent-rules', '40-commands.md'));
        resolvedCommandsPath = requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(commandsPathValue, repoRoot),
            'CommandsPath'
        );
        compileCommands = getCompileCommands(resolvedCommandsPath);
        resolvedPreflightPath = resolvePreflightPath(repoRoot, options.preflightPath || '', resolvedTaskId);
        preflightContext = getPreflightContext(resolvedPreflightPath, resolvedTaskId);
        rulePackEvidence = getRulePackEvidence(repoRoot, resolvedTaskId, 'POST_PREFLIGHT', {
            artifactPath: String(options.rulePackPath || ''),
            preflightPath: resolvedPreflightPath,
            taskModePath: String(options.taskModePath || '')
        });
        const taskModeViolations = getTaskModeEvidenceViolations(taskModeEvidence);
        const rulePackViolations = getRulePackEvidenceViolations(rulePackEvidence);
        if (taskModeViolations.length > 0) {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = taskModeViolations.join(' ');
        } else if (rulePackViolations.length > 0) {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = rulePackViolations.join(' ');
        }
        const preflightChangedFiles = expandValueList(preflightContext.changed_files, { splitDelimiters: false });
        const preCompileManifestEvidence = gateHelpers.evaluateProtectedControlPlaneManifest(repoRoot, null, true);
        const preCompileTaskOwnedManifestFiles = getTaskOwnedManifestChangedFiles(
            preflightChangedFiles,
            preCompileManifestEvidence.changed_files
        );
        const preCompileRestartHint = taskModeEvidence.orchestrator_work !== true
            ? buildClassifyChangeOrchestratorWorkRestartCommand({
                repoRoot,
                taskId: resolvedTaskId,
                taskModeEvidence,
                taskSummary: taskModeEvidence.task_summary || null,
                changedFiles: [...preflightChangedFiles, ...preCompileTaskOwnedManifestFiles]
            })
            : undefined;
        protectedManifestGuard = getProtectedManifestLifecycleGuard({
            repoRoot,
            orchestratorWork: taskModeEvidence.orchestrator_work === true,
            phaseLabel: 'compile gate',
            preflight: preflightContext.preflight,
            manifestEvidence: preCompileManifestEvidence,
            restartCommandHint: preCompileRestartHint
        });
        if (!exceptionMessage && protectedManifestGuard.status === 'BLOCK') {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = protectedManifestGuard.violations.join(' ');
        }
        if (!exceptionMessage) {
            workflowConfigBaselineForCompile = taskModeEvidence.workflow_config_file_hashes;
            const workflowConfigChanges = getCurrentWorkflowConfigChanges(repoRoot, workflowConfigBaselineForCompile);
            const workflowConfigViolations = getWorkflowConfigWorkViolations({
                changedFiles: mergePathLists(
                    workflowConfigChanges.changed_files,
                    workflowConfigBaselineForCompile
                        ? []
                        : getWorkflowConfigChangedFiles(preflightChangedFiles, getWorkflowConfigControlPlanePaths(repoRoot))
                ),
                taskModeEvidence,
                phaseLabel: 'compile gate',
                baselineFileHashes: workflowConfigBaselineForCompile,
                currentFileHashes: workflowConfigChanges.current_file_hashes
            });
            if (workflowConfigViolations.length > 0) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = workflowConfigViolations.join(' ');
                if (workflowConfigChanges.scan_error) {
                    exceptionMessage += ` Workspace scan warning: ${workflowConfigChanges.scan_error}`;
                }
            }
        }
        workspaceSnapshot = getWorkspaceSnapshotCached(
            repoRoot,
            preflightContext.detection_source,
            preflightContext.include_untracked,
            preflightChangedFiles
        );
        dirtyWorkspaceProtectionDrift = detectProtectedDirtyWorkspaceDrift(
            repoRoot,
            getProtectedDirtyWorkspaceScopeFromPreflight(preflightContext.preflight)
        );

        const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`));
        const timelineEvidence = readOptionalSkillSelectionTimelineEvidence(orchestratorRoot, resolvedTaskId, timelinePath);
        const timelineErrors: string[] = [];
        const timelineEventTypes = timelineEvidence.eventTypes;
        if (!timelineEvidence.exists) {
            timelineErrors.push(`Task timeline not found: ${gateHelpers.normalizePath(timelineEvidence.timelinePath)}`);
        } else if (timelineEvidence.invalidJson) {
            timelineErrors.push(`Task timeline contains invalid JSON line: ${gateHelpers.normalizePath(timelineEvidence.timelinePath)}`);
        }
        if (!exceptionMessage && timelineErrors.length > 0) {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = timelineErrors.join(' ');
        } else if (!exceptionMessage && !timelineEventTypes.has('RULE_PACK_LOADED')) {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = `Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing RULE_PACK_LOADED. Run load-rule-pack before compile gate.`;
        } else if (!exceptionMessage && !timelineEventTypes.has('HANDSHAKE_DIAGNOSTICS_RECORDED')) {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = `Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing HANDSHAKE_DIAGNOSTICS_RECORDED. Run handshake-diagnostics before compile gate.`;
        } else if (!exceptionMessage && !timelineEventTypes.has('SHELL_SMOKE_PREFLIGHT_RECORDED')) {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = `Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing SHELL_SMOKE_PREFLIGHT_RECORDED. Run shell-smoke-preflight before compile gate.`;
        }
        if (!exceptionMessage) {
            const handshakeEvidence = getHandshakeEvidence(repoRoot, resolvedTaskId, {
                taskModePath: options.taskModePath || '',
                timelinePath
            });
            const shellSmokeEvidence = getShellSmokeEvidence(repoRoot, resolvedTaskId, { timelinePath });
            const handshakeViolations = getHandshakeEvidenceViolations(handshakeEvidence);
            const shellSmokeViolations = getShellSmokeEvidenceViolations(shellSmokeEvidence);
            if (handshakeViolations.length > 0 || shellSmokeViolations.length > 0) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = [...handshakeViolations, ...shellSmokeViolations].join(' ');
            }
        }
        if (!exceptionMessage) {
            const optionalSkillPolicyMode = isOptionalSkillSelectionPolicyConfigured(orchestratorRoot)
                ? readOptionalSkillSelectionPolicyConfig(orchestratorRoot).mode
                : null;
            const loadedHeadlinesCache = optionalSkillPolicyMode
                ? loadOptionalSkillSelectionHeadlinesCache(orchestratorRoot, optionalSkillPolicyMode, {
                    preferPersistedSurface: true
                })
                : null;
            const expectedTaskTextSha256 = computeOptionalSkillTaskTextSha256(
                String(readCurrentTaskSummary(repoRoot, resolvedTaskId, taskModeEvidence.task_summary) || '')
            );
            const optionalSkillSelectionViolations = getOptionalSkillSelectionGateViolations(orchestratorRoot, resolvedTaskId, {
                expectedPreflightPath: normalizeOptionalPath(resolvedPreflightPath),
                expectedPreflightSha256: gateHelpers.fileSha256(resolvedPreflightPath),
                expectedTaskTextSha256,
                timelineEvidence,
                loadedHeadlinesCache
            });
            if (optionalSkillSelectionViolations.length > 0) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = optionalSkillSelectionViolations.join(' ');
            }
        }

        const shouldExplainPostPreflightSequence = !!resolvedPreflightPath && (
            !exceptionMessage
            || rulePackEvidence.evidence_status === 'EVIDENCE_FILE_MISSING'
            || rulePackEvidence.evidence_status === 'EVIDENCE_STAGE_MISSING'
            || rulePackEvidence.evidence_status === 'EVIDENCE_PREFLIGHT_PATH_MISMATCH'
            || rulePackEvidence.evidence_status === 'EVIDENCE_PREFLIGHT_HASH_MISMATCH'
            || rulePackEvidence.evidence_status === 'EVIDENCE_NOT_PASS'
        );
        if (shouldExplainPostPreflightSequence && resolvedPreflightPath && timelineErrors.length === 0) {
            postPreflightSequenceEvidence = getPostPreflightSequenceEvidence(repoRoot, resolvedTaskId, resolvedPreflightPath, {
                artifactPath: String(options.rulePackPath || ''),
                taskModePath: String(options.taskModePath || '')
            });
            if (postPreflightSequenceEvidence.violations.length > 0) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = postPreflightSequenceEvidence.violations.join(' ');
            }
        }

        budgetTokensForOutputFilters = resolveBudgetTokensFromForecast(
            preflightContext ? (preflightContext as Record<string, unknown>).budget_forecast : null
        );

        const scopeViolations: string[] = [];
        if (workspaceSnapshot.changed_files_sha256 !== preflightContext.changed_files_sha256) {
            scopeViolations.push('Preflight changed_files differ from current workspace snapshot.');
        }
        if (workspaceSnapshot.changed_lines_total !== preflightContext.changed_lines_total) {
            scopeViolations.push(
                `Preflight changed_lines_total=${preflightContext.changed_lines_total} differs from current snapshot changed_lines_total=${workspaceSnapshot.changed_lines_total}.`
            );
        }
        if (preflightContext.scope_sha256 && workspaceSnapshot.scope_sha256 !== preflightContext.scope_sha256) {
            scopeViolations.push(
                `Preflight scope_sha256=${preflightContext.scope_sha256} differs from current snapshot scope_sha256=${workspaceSnapshot.scope_sha256}.`
            );
        }
        if (!exceptionMessage && scopeViolations.length > 0) {
            exitCode = EXIT_GATE_FAILURE;
            const scopeRecoveryHint = preflightContext.detection_source === 'explicit_changed_files'
                ? 'Refresh preflight for the real diff: rerun classify-change for the current scope, rerun load-rule-pack --stage POST_PREFLIGHT, and then rerun compile-gate. If the original preflight used planned --changed-file inputs in a clean workspace before implementation, this drift is expected once the real diff exists.'
                : 'Refresh preflight for the current scope before compile: rerun classify-change, rerun load-rule-pack --stage POST_PREFLIGHT, and then rerun compile-gate.';
            exceptionMessage = `Preflight scope drift detected. ${scopeRecoveryHint} ${scopeViolations.join(' ')}`;
        }
        if (!exceptionMessage && dirtyWorkspaceProtectionDrift.status === 'DRIFT_DETECTED') {
            exitCode = EXIT_GATE_FAILURE;
            exceptionMessage = dirtyWorkspaceProtectionDrift.violations.join(' ');
        }

        if (!exceptionMessage && taskModeEvidence.plan && taskModeEvidence.plan.plan_path) {
            let loadedPlan: import('../../../schemas/task-plan').TaskPlan | null = null;
            let planLoadError: string | null = null;
            try {
                const planFilePath = gateHelpers.resolvePathInsideRepo(taskModeEvidence.plan.plan_path, repoRoot, { allowMissing: false });
                if (!planFilePath || !fs.existsSync(planFilePath) || !fs.statSync(planFilePath).isFile()) {
                    planLoadError = `Plan artifact not found at '${taskModeEvidence.plan.plan_path}'. Replan the task or remove plan metadata.`;
                } else {
                    const planJson = JSON.parse(fs.readFileSync(planFilePath, 'utf8'));
                    const validated = validateTaskPlan(planJson);
                    if (validated.task_id !== resolvedTaskId) {
                        planLoadError = `Plan task_id '${validated.task_id}' does not match task '${resolvedTaskId}'.`;
                    } else if (!isApprovedPlan(validated)) {
                        planLoadError = `Plan status is '${validated.status}'; only approved plans enforce drift detection.`;
                    } else {
                        const digest = computeTaskPlanDigest(validated);
                        if (taskModeEvidence.plan.plan_sha256 && digest !== taskModeEvidence.plan.plan_sha256) {
                            planLoadError = `Plan integrity mismatch: task-mode sha256='${taskModeEvidence.plan.plan_sha256}' vs current='${digest}'. Plan may have been edited after approval.`;
                        } else {
                            loadedPlan = validated;
                        }
                    }
                }
            } catch (planError: unknown) {
                planLoadError = `Plan load/parse failed: ${getErrorMessage(planError)}. Replan the task or remove plan metadata.`;
            }

            if (planLoadError) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = planLoadError;
            } else {
                planDriftResult = detectPlanDrift({
                    plan: loadedPlan,
                    actualFiles: preflightContext.changed_files as string[],
                    allowPlanDrift: parseBooleanOption(options.allowPlanDrift, false),
                    allowPlanDriftReason: String(options.allowPlanDriftReason || '').trim() || undefined
                });

                if (planDriftResult.status === 'REPLAN_REQUIRED') {
                    exitCode = EXIT_GATE_FAILURE;
                    exceptionMessage = planDriftResult.violations.join(' ');
                }
            }
        }

        if (!exceptionMessage) {
            await emitMandatoryImplementationStartedEventAsync(orchestratorRoot, resolvedTaskId, {
                preflight_path: gateHelpers.normalizePath(resolvedPreflightPath),
                commands_path: normalizeOptionalPath(resolvedCommandsPath),
                changed_files_count: preflightContext.changed_files.length,
                changed_lines_total: preflightContext.changed_lines_total
            });
            preflightHash = gateHelpers.fileSha256(resolvedPreflightPath);
            compileOutputInitialized = true;

            for (let index = 0; index < compileCommands.length; index += 1) {
                const compileCommand = compileCommands[index];
                const commandProfile = getCompileCommandProfile(compileCommand);
                const execution = await executeCommandAsync(compileCommand, {
                    cwd: repoRoot,
                    timeoutMs: DEFAULT_COMPILE_TIMEOUT_MS
                });
                const stats = getOutputStats(execution.outputLines);
                compileCommandAudits.push(auditGateCommand(compileCommand, 'compile-gate'));

                compileOutputLines.push(...execution.outputLines);
                warningCount += stats.warningLines;
                errorCount += stats.errorLines;
                compileOutputChunks.push(
                    formatCompileOutputEntry(index + 1, compileCommands.length, compileCommand, execution.outputLines)
                );

                if (execution.exitCode !== 0) {
                    exitCode = execution.exitCode;
                    exceptionMessage = `Compile command #${index + 1} exited with code ${execution.exitCode}.`;
                    selectedCommandProfile = commandProfile;
                    selectedCommandIndex = index + 1;
                    break;
                }

                if (index === 0) {
                    selectedCommandProfile = commandProfile;
                    selectedCommandIndex = 1;
                }
            }
            if (compileOutputPath && compileOutputInitialized) {
                writeTextArtifact(compileOutputPath, compileOutputChunks.join(''));
            }
        }
        if (!exceptionMessage) {
            const postCompileWorkflowConfigChanges = getCurrentWorkflowConfigChanges(repoRoot, workflowConfigBaselineForCompile);
            const postCompileWorkflowConfigViolations = getWorkflowConfigWorkViolations({
                changedFiles: postCompileWorkflowConfigChanges.changed_files,
                taskModeEvidence,
                phaseLabel: 'compile output validation',
                baselineFileHashes: workflowConfigBaselineForCompile,
                currentFileHashes: postCompileWorkflowConfigChanges.current_file_hashes
            });
            if (postCompileWorkflowConfigViolations.length > 0) {
                exitCode = EXIT_GATE_FAILURE;
                exceptionMessage = postCompileWorkflowConfigViolations.join(' ');
                if (postCompileWorkflowConfigChanges.scan_error) {
                    exceptionMessage += ` Workspace scan warning: ${postCompileWorkflowConfigChanges.scan_error}`;
                }
            }
        }
        if (!exceptionMessage && taskModeEvidence.orchestrator_work !== true) {
            const postCompileManifestEvidence = gateHelpers.evaluateProtectedControlPlaneManifest(repoRoot, null, true);
            if (postCompileManifestEvidence.status === 'DRIFT') {
                const postCompileGeneratedManifestFiles = getNewManifestChangedFiles(
                    preCompileManifestEvidence.changed_files,
                    postCompileManifestEvidence.changed_files
                );
                const postCompileRestartHint = buildClassifyChangeOrchestratorWorkRestartCommand({
                    repoRoot,
                    taskId: resolvedTaskId,
                    taskModeEvidence,
                    taskSummary: taskModeEvidence.task_summary || null,
                    changedFiles: [
                        ...preflightChangedFiles,
                        ...preCompileTaskOwnedManifestFiles,
                        ...postCompileGeneratedManifestFiles
                    ]
                });
                const postCompileManifestGuard = getProtectedManifestLifecycleGuard({
                    repoRoot,
                    orchestratorWork: false,
                    phaseLabel: 'compile output validation',
                    preflight: preflightContext?.preflight,
                    manifestEvidence: postCompileManifestEvidence,
                    restartCommandHint: postCompileRestartHint
                });
                if (postCompileManifestGuard.status === 'BLOCK') {
                    exitCode = EXIT_GATE_FAILURE;
                    exceptionMessage = postCompileManifestGuard.violations.join(' ');
                }
            }
        }
    } catch (error) {
        exceptionMessage = getErrorMessage(error);
        if (exitCode === 0) {
            exitCode = EXIT_GATE_FAILURE;
        }
    }
    if (exceptionMessage) {
        exceptionMessage = appendNextStepRecoveryHint(exceptionMessage, repoRoot, resolvedTaskId);
    }

    const durationMs = Math.max(0, Date.now() - startedAt);
    const fallbackProfile = compileCommands.length > 0
        ? getCompileCommandProfile(compileCommands[0])
        : {
            kind: 'compile',
            strategy: 'generic',
            label: 'compile',
            failure_profile: 'compile_failure_console_generic',
            success_profile: 'compile_success_console'
        };
    const effectiveProfile = selectedCommandProfile || fallbackProfile;
    const selectedOutputProfile = exceptionMessage ? effectiveProfile.failure_profile : effectiveProfile.success_profile;
    const filteredOutput = applyOutputFilterProfile(compileOutputLines, outputFiltersPath, selectedOutputProfile, {
        budgetTokens: budgetTokensForOutputFilters,
        context: {
            fail_tail_lines: failTailLines,
            command_filter_strategy: effectiveProfile.strategy,
            command_kind: effectiveProfile.kind
        }
    });
    const outputTelemetry = buildOutputTelemetry(compileOutputLines, filteredOutput.lines, {
        filterMode: filteredOutput.filter_mode,
        fallbackMode: filteredOutput.fallback_mode,
        parserMode: filteredOutput.parser_mode,
        parserName: filteredOutput.parser_name ?? undefined,
        parserStrategy: filteredOutput.parser_strategy ?? undefined
    });
    const telemetrySummary: OutputTelemetrySummary = {
        filter_mode: filteredOutput.filter_mode,
        fallback_mode: filteredOutput.fallback_mode,
        parser_mode: filteredOutput.parser_mode ?? 'NONE',
        parser_name: filteredOutput.parser_name ?? null,
        parser_strategy: filteredOutput.parser_strategy ?? null,
        original_lines: compileOutputLines.length,
        filtered_lines: filteredOutput.lines.length
    };
    const visibleSavingsLine = formatVisibleSavingsLine(outputTelemetry);

    const gateContext: Record<string, unknown> = {
        commands_path: normalizeOptionalPath(resolvedCommandsPath),
        compile_commands: compileCommands,
        compile_command: compileCommands.length > 0 ? compileCommands[0] : null,
        preflight_path: normalizeOptionalPath(resolvedPreflightPath),
        preflight_hash_sha256: preflightHash,
        preflight_detection_source: preflightContext ? preflightContext.detection_source : null,
        preflight_include_untracked: preflightContext ? !!preflightContext.include_untracked : null,
        preflight_changed_files_count: preflightContext ? preflightContext.changed_files_count : null,
        preflight_changed_lines_total: preflightContext ? preflightContext.changed_lines_total : null,
        preflight_changed_files_sha256: preflightContext ? preflightContext.changed_files_sha256 : null,
        preflight_scope_sha256: preflightContext ? preflightContext.scope_sha256 : null,
        preflight_scope_content_sha256: preflightContext ? preflightContext.scope_content_sha256 : null,
        task_mode: taskModeEvidence,
        rule_pack: rulePackEvidence,
        post_preflight_sequence: postPreflightSequenceEvidence,
        scope_detection_source: workspaceSnapshot ? workspaceSnapshot.detection_source : null,
        scope_use_staged: workspaceSnapshot ? !!workspaceSnapshot.use_staged : null,
        scope_include_untracked: workspaceSnapshot ? !!workspaceSnapshot.include_untracked : null,
        scope_changed_files: workspaceSnapshot ? workspaceSnapshot.changed_files : [],
        scope_changed_files_count: workspaceSnapshot ? workspaceSnapshot.changed_files_count : 0,
        scope_changed_lines_total: workspaceSnapshot ? workspaceSnapshot.changed_lines_total : 0,
        scope_changed_files_sha256: workspaceSnapshot ? workspaceSnapshot.changed_files_sha256 : null,
        scope_content_sha256: workspaceSnapshot ? workspaceSnapshot.scope_content_sha256 : null,
        scope_sha256: workspaceSnapshot ? workspaceSnapshot.scope_sha256 : null,
        dirty_workspace_protection: dirtyWorkspaceProtectionDrift,
        protected_manifest: protectedManifestGuard ? {
            status: protectedManifestGuard.manifest_evidence.status,
            manifest_path: protectedManifestGuard.manifest_evidence.manifest_path,
            changed_files: protectedManifestGuard.manifest_evidence.changed_files
        } : null,
        evidence_path: normalizeOptionalPath(compileEvidencePath),
        compile_output_path: normalizeOptionalPath(compileOutputPath),
        output_filters_path: normalizeOptionalPath(outputFiltersPath),
        command_kind: effectiveProfile.kind,
        command_filter_strategy: effectiveProfile.strategy,
        command_profile_label: effectiveProfile.label,
        selected_output_profile: selectedOutputProfile,
        selected_budget_tier: filteredOutput.budget_tier ?? null,
        selected_command_index: selectedCommandIndex,
        compile_output_lines: compileOutputLines.length,
        compile_output_warning_lines: warningCount,
        compile_output_error_lines: errorCount,
        duration_ms: durationMs,
        exit_code: exceptionMessage ? exitCode : 0,
        command_policy_audits: compileCommandAudits,
        command_policy_warning_count: compileCommandAudits.reduce((sum, a) => sum + a.warning_count, 0),
        plan_drift: planDriftResult,
        ...outputTelemetry
    };

    if (exceptionMessage) {
        const failureEvent = {
            timestamp_utc: new Date().toISOString(),
            event_type: 'compile_gate_check',
            status: 'FAILED',
            task_id: resolvedTaskId,
            error: exceptionMessage,
            ...gateContext
        };
        appendMetricsIfEnabled(repoRoot, metricsPath, failureEvent, parseBooleanOption(options.emitMetrics, true));
        let failureReason = exceptionMessage;
        try {
            await appendMandatoryTaskEventAsync(orchestratorRoot, resolvedTaskId, 'COMPILE_GATE_FAILED', 'FAIL', 'Compile gate failed.', failureEvent);
        } catch (eventError: unknown) {
            failureReason = `Compile gate failed and mandatory lifecycle event 'COMPILE_GATE_FAILED' could not be appended. Original gate error: ${exceptionMessage} | Event append error: ${getErrorMessage(eventError)}`;
        }
        writeCompileEvidence(compileEvidencePath, resolvedTaskId, gateContext, 'FAILED', 'FAIL', failureReason);

        const outputLines = [
            'COMPILE_GATE_FAILED',
            `CompileSummary: FAILED | duration_ms=${durationMs} | exit_code=${exitCode} | errors=${errorCount} | warnings=${warningCount}`
        ];
        if (compileOutputPath) {
            outputLines.push(`CompileOutputPath: ${gateHelpers.normalizePath(compileOutputPath)}`);
        }
        if (filteredOutput.lines.length > 0) {
            if (telemetrySummary.parser_mode === 'FULL' || telemetrySummary.parser_mode === 'DEGRADED') {
                outputLines.push(
                    `CompileOutputCompactSummary: parser=${telemetrySummary.parser_name} mode=${telemetrySummary.parser_mode} strategy=${telemetrySummary.parser_strategy}`
                );
            } else if (telemetrySummary.filter_mode.startsWith('profile:') && telemetrySummary.fallback_mode === 'none') {
                outputLines.push(`CompileOutputFilteredLines: profile=${telemetrySummary.filter_mode}`);
            } else {
                outputLines.push('CompileOutputFilteredLines:');
            }
            outputLines.push(...filteredOutput.lines);
        }
        if (visibleSavingsLine) {
            outputLines.push(visibleSavingsLine);
        }
        outputLines.push(`Reason: ${failureReason}`);
        return { outputLines, exitCode: EXIT_GATE_FAILURE };
    }

    const successEvent = {
        timestamp_utc: new Date().toISOString(),
        event_type: 'compile_gate_check',
        status: 'PASSED',
        task_id: resolvedTaskId,
        ...gateContext
    };
    appendMetricsIfEnabled(repoRoot, metricsPath, successEvent, parseBooleanOption(options.emitMetrics, true));
    try {
        await appendMandatoryTaskEventAsync(orchestratorRoot, resolvedTaskId, 'COMPILE_GATE_PASSED', 'PASS', 'Compile gate passed.', successEvent);
    } catch (error: unknown) {
        const failureReason = `Compile gate succeeded but mandatory lifecycle event 'COMPILE_GATE_PASSED' could not be appended. ${getErrorMessage(error)}`;
        writeCompileEvidence(compileEvidencePath, resolvedTaskId, gateContext, 'FAILED', 'FAIL', failureReason);
        return {
            outputLines: [
                'COMPILE_GATE_FAILED',
                `CompileSummary: FAILED | duration_ms=${durationMs} | exit_code=0 | errors=${errorCount} | warnings=${warningCount}`,
                `Reason: ${failureReason}`
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }
    writeCompileEvidence(compileEvidencePath, resolvedTaskId, gateContext, 'PASSED', 'PASS', null);

    const outputLines = [
        'COMPILE_GATE_PASSED',
        `CompileSummary: PASSED | duration_ms=${durationMs} | exit_code=0 | errors=${errorCount} | warnings=${warningCount}`
    ];
    if (planDriftResult) {
        outputLines.push(`PlanDrift: ${planDriftResult.status}`);
        if (planDriftResult.status === 'PLAN_DRIFT') {
            outputLines.push(`PlanDriftExtraFiles: ${planDriftResult.extra_files.join(', ')}`);
        }
    }
    if (compileOutputPath) {
        outputLines.push(`CompileOutputPath: ${gateHelpers.normalizePath(compileOutputPath)}`);
    }
    if (visibleSavingsLine) {
        outputLines.push(visibleSavingsLine);
    }
    return { outputLines, exitCode: 0 };
}
