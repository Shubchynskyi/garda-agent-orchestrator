import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    selectRulePackFiles
} from '../review-context/review-context-token-economy';
import {
    normalizePath
} from '../shared/helpers';
import type {
    TaskQueueEntry
} from './next-step-task-queue';
import {
    buildBundleRelativePath,
    quoteCommandValue
} from './next-step-command-formatters';
import {
    buildReviewPhaseCommand,
    buildTaskModePathCommandParts
} from './next-step-review-command-builders';
import {
    getPreflightChangedFiles
} from './next-step-doc-closeout-readiness';
import {
    resolveTaskProfileSelection
} from '../../policy/task-profile-selection';
import {
    resolveBundleRootForTarget
} from '../../core/constants';
import {
    expandDependencyManifestLockfileScope
} from '../scope/dependency-manifest-lockfile-scope';
import {
    REVIEW_CONTRACTS
} from '../required-reviews/required-reviews-check';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveDefaultDepthFromTaskQueue(repoRoot: string, taskEntry: TaskQueueEntry | null): string {
    try {
        const resolvedProfile = resolveTaskProfileSelection(
            resolveBundleRootForTarget(repoRoot),
            taskEntry?.profile || null
        );
        const depth = resolvedProfile.effective_policy.depth;
        if (Number.isInteger(depth) && depth >= 1 && depth <= 3) {
            return String(depth);
        }
    } catch {
        // Fall back to legacy queue-name mapping when profile config is unavailable.
    }
    const profile = String(taskEntry?.profile || '').trim().toLowerCase();
    if (profile === 'fast' || profile === 'docs-only') return '1';
    return '2';
}

function resolveDefaultDepthFromTaskMode(taskMode: Record<string, unknown> | null): string {
    // Restart commands must preserve the task-mode artifact snapshot. Fresh task
    // entry resolves profile defaults; restart should not drift if profiles.json changes later.
    return getNumberField(taskMode, 'requested_depth', '<1|2|3>');
}

function shouldPreserveEffectiveDepthForRestart(
    taskMode: Record<string, unknown> | null,
    requestedDepth: string,
    effectiveDepth: string
): boolean {
    if (!effectiveDepth) {
        return false;
    }
    const effectiveDepthSource = getStringField(taskMode, 'effective_depth_source', '');
    if (effectiveDepthSource === 'explicit') {
        return true;
    }
    return !effectiveDepthSource && requestedDepth !== effectiveDepth;
}

export function getStringField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const rawValue = source?.[field];
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    return value || fallback;
}

function getNumberField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const value = source?.[field];
    return Number.isInteger(value) ? String(value) : fallback;
}

function buildProtectedOperatorConfirmationCommandParts(): string[] {
    return [
        '--operator-confirmed yes',
        '--operator-confirmed-at-utc "<ISO-8601 timestamp>"'
    ];
}

function readGitPathLines(repoRoot: string, args: string[]): string[] | null {
    try {
        const output = childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10000
        });
        return String(output || '').split(/\r?\n/).map((entry) => normalizePath(entry)).filter(Boolean);
    } catch {
        return null;
    }
}

function readCurrentWorkspaceChangedFiles(repoRoot: string): { changedFiles: string[]; reliable: boolean } {
    const trackedChangedFiles = readGitPathLines(repoRoot, ['diff', '--name-only', '--diff-filter=ACDMRTUXB', 'HEAD', '--']);
    const untrackedChangedFiles = readGitPathLines(repoRoot, ['ls-files', '--others', '--exclude-standard']);
    if (trackedChangedFiles === null || untrackedChangedFiles === null) {
        return { changedFiles: [], reliable: false };
    }
    return {
        changedFiles: [...new Set([
            ...trackedChangedFiles,
            ...untrackedChangedFiles
        ])].sort(),
        reliable: true
    };
}

function readCurrentStagedChangedFiles(repoRoot: string): string[] | null {
    return readGitPathLines(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB', '--']);
}

function isSafeRepoRelativePath(relativePath: string): boolean {
    const normalizedPath = normalizePath(relativePath).replace(/\/+$/, '');
    if (!normalizedPath || normalizedPath === '.' || path.isAbsolute(normalizedPath)) {
        return false;
    }
    return !normalizedPath.split('/').includes('..');
}

function isPlainDirectoryPlaceholder(repoRoot: string, relativePath: string): boolean {
    if (!isSafeRepoRelativePath(relativePath)) {
        return false;
    }
    const absolutePath = path.resolve(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
        return false;
    }
    const fileStatus = fs.lstatSync(absolutePath);
    return fileStatus.isDirectory() && !fileStatus.isSymbolicLink();
}

function expandDirectoryPlaceholdersForCommand(repoRoot: string, scopeFiles: string[]): string[] {
    const normalizedScopeFiles = [...new Set(scopeFiles.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    if (normalizedScopeFiles.length === 0) {
        return [];
    }
    const currentWorkspace = readCurrentWorkspaceChangedFiles(repoRoot);
    if (!currentWorkspace.reliable) {
        return normalizedScopeFiles;
    }
    const currentChangedFiles = currentWorkspace.changedFiles;
    if (currentChangedFiles.length === 0) {
        return normalizedScopeFiles.filter((entry) => {
            return !isPlainDirectoryPlaceholder(repoRoot, entry);
        });
    }
    const atomicScopeFiles = expandDependencyManifestLockfileScope(normalizedScopeFiles, currentChangedFiles);

    const expanded = new Set<string>();
    for (const scopeFile of atomicScopeFiles) {
        if (currentChangedFiles.includes(scopeFile)) {
            expanded.add(scopeFile);
        }
        const prefix = `${scopeFile.replace(/\/+$/, '')}/`;
        const matchingCurrentFiles = currentChangedFiles.filter((changedFile) => changedFile.startsWith(prefix));
        if (matchingCurrentFiles.length > 0) {
            for (const matchingFile of matchingCurrentFiles) {
                expanded.add(matchingFile);
            }
            continue;
        }

        if (isPlainDirectoryPlaceholder(repoRoot, scopeFile)) {
            continue;
        }
        expanded.add(scopeFile);
    }
    return [...expanded].sort();
}

export function quoteProviderForCommand(provider: string | null): string {
    if (provider) {
        return quoteCommandValue(provider);
    }
    return process.platform === 'win32'
        ? '"$env:GARDA_EXECUTION_PROVIDER"'
        : '"$GARDA_EXECUTION_PROVIDER"';
}

export function buildEnterTaskModeCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskEntry: TaskQueueEntry | null,
    provider: string | null
): string {
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        '--entry-mode "EXPLICIT_TASK_EXECUTION"',
        `--requested-depth ${quoteCommandValue(resolveDefaultDepthFromTaskQueue(repoRoot, taskEntry))}`,
        `--task-summary ${quoteCommandValue(taskEntry?.title || taskId)}`
    ];
    parts.push(`--provider ${quoteProviderForCommand(provider)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function buildOrchestratorWorkRestartCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskMode: Record<string, unknown> | null,
    additionalPlannedChangedFiles: string[] = [],
    includeWorkflowConfigWork = false
): string {
    const requestedDepth = resolveDefaultDepthFromTaskMode(taskMode);
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--entry-mode ${quoteCommandValue(getStringField(taskMode, 'entry_mode', 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quoteCommandValue(requestedDepth)}`,
        `--task-summary ${quoteCommandValue(getStringField(taskMode, 'task_summary', '<TASK.md summary>'))}`,
        `--provider ${quoteCommandValue(getStringField(taskMode, 'provider', '<provider>'))}`
    ];
    const startBanner = getStringField(taskMode, 'start_banner', '');
    if (startBanner) {
        parts.push(`--start-banner ${quoteCommandValue(startBanner)}`);
    }
    const routedTo = getStringField(taskMode, 'routed_to', '');
    if (routedTo) {
        parts.push(`--routed-to ${quoteCommandValue(routedTo)}`);
    }
    const effectiveDepth = getNumberField(taskMode, 'effective_depth', '');
    if (shouldPreserveEffectiveDepthForRestart(taskMode, requestedDepth, effectiveDepth)) {
        parts.push(`--effective-depth ${quoteCommandValue(effectiveDepth)}`);
    }
    parts.push('--orchestrator-work');
    if (includeWorkflowConfigWork) {
        parts.push('--workflow-config-work');
    }
    parts.push(...buildProtectedOperatorConfirmationCommandParts());
    const plannedChangedFiles = Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const dirtyBaselineChangedFiles = getTaskModeDirtyWorkspaceBaselineChangedFiles(taskMode);
    const currentChangedFiles = additionalPlannedChangedFiles
        .map((entry) => normalizePath(entry))
        .filter(Boolean);
    const restartScopeFiles = currentChangedFiles.length > 0
        ? currentChangedFiles
        : dirtyBaselineChangedFiles.length > 0
            ? dirtyBaselineChangedFiles
            : plannedChangedFiles;
    const mergedPlannedChangedFiles = expandDirectoryPlaceholdersForCommand(repoRoot, restartScopeFiles);
    for (const plannedChangedFile of mergedPlannedChangedFiles) {
        parts.push(`--planned-changed-file ${quoteCommandValue(plannedChangedFile)}`);
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function getTaskModePlannedChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    return Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
}

export function getTaskModeDirtyWorkspaceBaselineChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    if (taskMode?.orchestrator_work !== true) {
        return [];
    }
    const dirtyWorkspaceBaseline = taskMode.dirty_workspace_baseline;
    if (!dirtyWorkspaceBaseline || typeof dirtyWorkspaceBaseline !== 'object' || Array.isArray(dirtyWorkspaceBaseline)) {
        return [];
    }
    const changedFiles = (dirtyWorkspaceBaseline as Record<string, unknown>).changed_files;
    return Array.isArray(changedFiles)
        ? changedFiles.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
}

export function getTaskModeDirtyWorkspaceBaselineFileHashes(taskMode: Record<string, unknown> | null): Record<string, string> {
    if (taskMode?.orchestrator_work !== true) {
        return {};
    }
    const dirtyWorkspaceBaseline = taskMode.dirty_workspace_baseline;
    if (!dirtyWorkspaceBaseline || typeof dirtyWorkspaceBaseline !== 'object' || Array.isArray(dirtyWorkspaceBaseline)) {
        return {};
    }
    const fileHashes = (dirtyWorkspaceBaseline as Record<string, unknown>).file_hashes;
    if (!fileHashes || typeof fileHashes !== 'object' || Array.isArray(fileHashes)) {
        return {};
    }
    const normalized: Record<string, string> = {};
    for (const [filePath, hash] of Object.entries(fileHashes as Record<string, unknown>)) {
        const normalizedPath = normalizePath(filePath);
        const normalizedHash = typeof hash === 'string' ? hash.trim().toLowerCase() : '';
        if (normalizedPath && normalizedHash) {
            normalized[normalizedPath] = normalizedHash;
        }
    }
    return normalized;
}

function getTaskModeClassifyChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    const plannedChangedFiles = getTaskModePlannedChangedFiles(taskMode);
    if (taskMode?.workflow_config_work === true) {
        return [...new Set([
            ...plannedChangedFiles,
            ...getTaskModeDirtyWorkspaceBaselineChangedFiles(taskMode)
        ])].sort();
    }
    if (plannedChangedFiles.length > 0) {
        return [...new Set(plannedChangedFiles)].sort();
    }
    return [...new Set(getTaskModeDirtyWorkspaceBaselineChangedFiles(taskMode))].sort();
}

export function getPreflightRefreshChangedFiles(
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null
): string[] {
    const plannedChangedFiles = getTaskModeClassifyChangedFiles(taskMode);
    const detectionSource = String(preflight?.detection_source || '').trim().toLowerCase();
    const explicitPreflightChangedFiles = detectionSource === 'explicit_changed_files'
        ? getPreflightChangedFiles(preflight)
        : [];
    if (plannedChangedFiles.length > 0 || explicitPreflightChangedFiles.length > 0) {
        return [...new Set([
            ...plannedChangedFiles,
            ...explicitPreflightChangedFiles
        ])].sort();
    }
    if (detectionSource === 'explicit_changed_files') {
        return getPreflightChangedFiles(preflight);
    }
    return [];
}

export function buildClassifyChangeCommand(params: {
    repoRoot: string;
    cliPrefix: string;
    taskId: string;
    taskMode: Record<string, unknown> | null;
    taskModePath: string | null;
    preflightCommandPath: string;
    includePlannedScope: boolean;
    changedFiles?: string[];
}): string {
    const parts = [
        `${params.cliPrefix} gate classify-change`,
        `--task-id ${quoteCommandValue(params.taskId)}`,
        `--task-intent ${quoteCommandValue(getStringField(params.taskMode, 'task_summary', '<task summary>'))}`
    ];
    const changedFiles = params.changedFiles || (params.includePlannedScope
        ? getTaskModeClassifyChangedFiles(params.taskMode)
        : []);
    const expandedChangedFiles = expandDirectoryPlaceholdersForCommand(params.repoRoot, changedFiles);
    for (const changedFile of expandedChangedFiles) {
        parts.push(`--changed-file ${quoteCommandValue(changedFile)}`);
    }
    if (expandedChangedFiles.length === 0 && (readCurrentStagedChangedFiles(params.repoRoot)?.length || 0) > 0) {
        parts.push('--use-staged');
    }
    parts.push(...buildTaskModePathCommandParts(params.repoRoot, params.taskId, params.taskModePath));
    parts.push(`--output-path ${quoteCommandValue(params.preflightCommandPath)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function getEffectiveDepthForPostPreflightRules(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): number {
    const riskAwareDepth = isPlainRecord(preflight?.risk_aware_depth) ? preflight.risk_aware_depth : null;
    const preflightDepth = typeof riskAwareDepth?.effective_depth === 'number'
        ? riskAwareDepth.effective_depth
        : Number(riskAwareDepth?.effective_depth);
    if (Number.isInteger(preflightDepth) && preflightDepth >= 1) {
        return preflightDepth;
    }
    const taskModeDepth = typeof taskMode?.effective_depth === 'number'
        ? taskMode.effective_depth
        : Number(taskMode?.effective_depth);
    if (Number.isInteger(taskModeDepth) && taskModeDepth >= 1) {
        return taskModeDepth;
    }
    return 2;
}

export function getPostPreflightRuleFileNames(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): string[] {
    const fileNames = new Set<string>([
        '00-core.md',
        '15-project-memory.md',
        '40-commands.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ]);
    const requiredReviews = isPlainRecord(preflight?.required_reviews) ? preflight.required_reviews : {};
    const effectiveDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (required !== true) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }
    return [...fileNames].sort();
}

export function buildPostPreflightRulePackCommandForFiles(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    ruleFileNames: string[],
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "POST_PREFLIGHT"',
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        ...ruleFileNames.map((fileName) => (
            `--loaded-rule-file "${buildBundleRelativePath(repoRoot, `live/docs/agent-rules/${fileName}`)}"`
        )),
        '--repo-root "."'
    ].join(' ');
}

export function buildPostPreflightRulePackBindCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate bind-rule-pack-to-preflight`,
        `--task-id "${taskId}"`,
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

export function buildCompileGateCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate compile-gate`,
        `--task-id "${taskId}"`,
        `--preflight-path "${preflightCommandPath}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

export function buildQualityChecklistCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate quality-checklist`,
        `--task-id "${taskId}"`,
        `--preflight-path "${preflightCommandPath}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--answers-json "<JSON array with one answer object per enabled optional_quality_checks rule>"',
        '--repo-root "."'
    ].join(' ');
}

export function buildReviewContextCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewDepth: number,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate build-review-context`,
        `--review-type "${reviewType}"`,
        `--depth "${reviewDepth}"`,
        `--preflight-path "${preflightCommandPath}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

export function buildRequiredReviewsCheckCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    const parts = [
        `--preflight-path "${preflightCommandPath}"`
    ];
    const attestationPlaceholder = buildReviewAuthorshipAttestationFailClosedDefault(repoRoot, preflightCommandPath);
    if (attestationPlaceholder) {
        parts.push(`--review-authorship-attestation-json ${quoteCommandValue(attestationPlaceholder)}`);
    }
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'required-reviews-check', parts, taskModePath);
}

function buildReviewAuthorshipAttestationFailClosedDefault(repoRoot: string, preflightCommandPath: string): string | null {
    try {
        const preflightPath = path.resolve(repoRoot, preflightCommandPath);
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const requiredReviews = isPlainRecord(preflight.required_reviews)
            ? preflight.required_reviews
            : {};
        const requiredReviewTypes = REVIEW_CONTRACTS
            .map(([reviewType]) => reviewType)
            .filter((reviewType) => requiredReviews[reviewType] === true);
        if (requiredReviewTypes.length === 0) {
            return null;
        }
        return JSON.stringify(Object.fromEntries(requiredReviewTypes.map((reviewType) => [reviewType, false])));
    } catch {
        return null;
    }
}

export function buildCompletionGateCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'completion-gate', [
        `--preflight-path "${preflightCommandPath}"`
    ], taskModePath);
}
