import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getWorkspaceSnapshotCached } from './workspace-snapshot-cache';
import {
    fileSha256,
    getProtectedControlPlaneRoots,
    isWorkflowConfigControlPlanePath,
    isWorkflowConfigControlPlanePathShape,
    normalizePath,
    resolveProtectedControlPlaneManifestPath,
    toPlainRecord,
    computeProtectedSnapshotDigest
} from './helpers';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../core/subprocess';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../core/constants';
import {
    buildDefaultWorkflowConfig,
    isExactLegacyProjectMemoryGeneratedDefault
} from '../core/workflow-config';

export interface WorkflowConfigWorkEvidence {
    workflow_config_work?: boolean | null;
    orchestrator_work?: boolean | null;
    workflow_config_file_hashes?: Record<string, string | null> | null;
    identity_backfilled_from_legacy?: boolean | null;
}

export interface CurrentWorkflowConfigChanges {
    changed_files: string[];
    current_file_hashes: Record<string, string | null>;
    baseline_file_hashes: Record<string, string | null> | null;
    baseline_source: 'task_mode' | 'protected_manifest' | null;
    scan_error: string | null;
}

export interface WorkflowConfigPreTaskBaselineState {
    changed_files: string[];
    compatibility_baseline_files: string[];
}

interface ProtectedManifestWorkflowConfigHashes {
    status: 'missing' | 'present' | 'invalid';
    hashes: Record<string, string | null>;
}

export function getWorkflowConfigControlPlanePaths(repoRoot: string): string[] {
    return getProtectedControlPlaneRoots(repoRoot)
        .map((entry) => normalizePath(entry))
        .filter(isWorkflowConfigControlPlanePathShape)
        .sort();
}

export function getCurrentWorkflowConfigFileHashes(repoRoot: string): Record<string, string | null> {
    const hashes: Record<string, string | null> = {};
    for (const relativePath of getWorkflowConfigControlPlanePaths(repoRoot)) {
        hashes[relativePath] = fileSha256(path.join(repoRoot, ...relativePath.split('/')));
    }
    return hashes;
}

export function normalizeWorkflowConfigFileHashes(value: unknown): Record<string, string | null> | null {
    const record = toPlainRecord(value);
    if (!record) {
        return null;
    }
    const normalized: Record<string, string | null> = {};
    for (const [rawPath, rawHash] of Object.entries(record)) {
        const relativePath = normalizePath(rawPath);
        if (!relativePath || !isWorkflowConfigControlPlanePathShape(relativePath)) {
            continue;
        }
        const hashText = rawHash == null ? '' : String(rawHash || '').trim().toLowerCase();
        normalized[relativePath] = /^[a-f0-9]{64}$/.test(hashText) ? hashText : null;
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeSha256(value: unknown): string | null {
    const text = value == null ? '' : String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function isValidSha256(value: unknown): boolean {
    return normalizeSha256(value) !== null;
}

function readProtectedManifestWorkflowConfigHashes(
    repoRoot: string,
    workflowConfigPaths: readonly string[]
): ProtectedManifestWorkflowConfigHashes {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    if (!fs.existsSync(manifestPath)) {
        return { status: 'missing', hashes: {} };
    }

    try {
        if (!fs.statSync(manifestPath).isFile()) {
            return { status: 'invalid', hashes: {} };
        }
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const parsedRecord = toPlainRecord(parsed);
        const snapshot = toPlainRecord(parsedRecord?.protected_snapshot);
        if (!snapshot) {
            return { status: 'invalid', hashes: {} };
        }
        const hasDigest = parsedRecord
            ? Object.prototype.hasOwnProperty.call(parsedRecord, 'protected_snapshot_sha256')
            : false;
        const expectedDigest = hasDigest ? normalizeSha256(parsedRecord?.protected_snapshot_sha256) : null;
        if (hasDigest && (!expectedDigest || computeProtectedSnapshotDigest(snapshot as Record<string, string>) !== expectedDigest)) {
            return { status: 'invalid', hashes: {} };
        }
        const manifestHashes: Record<string, string | null> = {};
        for (const relativePath of workflowConfigPaths) {
            if (!Object.prototype.hasOwnProperty.call(snapshot, relativePath)) {
                continue;
            }
            if (!isValidSha256(snapshot[relativePath])) {
                return { status: 'invalid', hashes: {} };
            }
            manifestHashes[relativePath] = normalizeSha256(snapshot[relativePath]);
        }
        return { status: 'present', hashes: manifestHashes };
    } catch {
        return { status: 'invalid', hashes: {} };
    }
}

function readGitHeadFileSha256(repoRoot: string, relativePath: string): string | undefined {
    try {
        const result = spawnSyncWithTimeout('git', ['-C', repoRoot, 'show', `HEAD:${relativePath}`], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 20 * 1024 * 1024
        });
        if (result.status !== 0 || result.timedOut || result.error) {
            return undefined;
        }
        const stdout = Buffer.isBuffer(result.stdout)
            ? result.stdout
            : Buffer.from(String(result.stdout || ''), 'utf8');
        return crypto.createHash('sha256').update(stdout).digest('hex').toLowerCase();
    } catch {
        return undefined;
    }
}

function readGitIndexOrWorktreeStatus(repoRoot: string, relativePath: string): string[] | null {
    const normalizedRelativePath = normalizePath(relativePath);
    const targetPath = path.join(repoRoot, ...normalizedRelativePath.split('/'));
    const targetExists = fs.existsSync(targetPath);
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
            '--ignored=matching',
            '--',
            relativePath
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        });
        if (result.status !== 0 || result.timedOut || result.error) {
            return null;
        }
        return String(result.stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trimEnd())
            .filter((line) => {
                if (!line) {
                    return false;
                }
                const statusPath = normalizePath(line.slice(3).trim().replace(/^"|"$/g, ''));
                if (statusPath === normalizedRelativePath) {
                    return true;
                }
                const statusPathWithSlash = statusPath.endsWith('/') ? statusPath : `${statusPath}/`;
                return targetExists && normalizedRelativePath.startsWith(statusPathWithSlash);
            });
    } catch {
        return null;
    }
}

function isIgnoredOnlyGitStatus(statusLines: readonly string[]): boolean {
    return statusLines.length > 0 && statusLines.every((line) => line.startsWith('!! '));
}

const SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE = buildDefaultWorkflowConfig();
const SAFE_FULL_SUITE_COMPATIBILITY_COMMANDS = new Set([
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
    'npm test'
]);
const COMPATIBILITY_TOP_LEVEL_KEYS = [
    'full_suite_validation',
    'project_memory_maintenance',
    'review_cycle_guard',
    'review_execution_policy',
    'scope_budget_guard',
    'task_reset'
];
const COMPATIBILITY_PRE_TASK_RESET_TOP_LEVEL_KEYS = COMPATIBILITY_TOP_LEVEL_KEYS.filter(
    (key) => key !== 'task_reset'
);
const COMPATIBILITY_LEGACY_REVIEW_POLICY_TOP_LEVEL_KEYS = COMPATIBILITY_TOP_LEVEL_KEYS.filter(
    (key) => key !== 'review_execution_policy'
);
const COMPATIBILITY_LEGACY_TOP_LEVEL_KEYS = COMPATIBILITY_TOP_LEVEL_KEYS.filter(
    (key) => key !== 'review_execution_policy' && key !== 'task_reset'
);
const COMPATIBILITY_FULL_SUITE_VALIDATION_KEYS = [
    'command',
    'enabled',
    'green_summary_max_lines',
    'out_of_scope_failure_policy',
    'red_failure_chunk_lines',
    'timeout_ms'
];
const COMPATIBILITY_REVIEW_EXECUTION_POLICY_KEYS = ['mode'];
const COMPATIBILITY_SCOPE_BUDGET_GUARD_KEYS = [
    'action',
    'enabled',
    'max_changed_lines',
    'max_files',
    'max_required_reviews',
    'max_review_tokens',
    'profiles'
];
const COMPATIBILITY_REVIEW_CYCLE_GUARD_KEYS = [
    'action',
    'auto_split_enabled',
    'enabled',
    'excluded_review_types',
    'max_failed_non_test_reviews',
    'max_total_non_test_reviews'
];
const COMPATIBILITY_PROJECT_MEMORY_MAINTENANCE_KEYS = [
    'enabled',
    'impact_artifact_retention_days',
    'max_compact_summary_chars',
    'mode',
    'read_strategy',
    'require_user_approval_for_writes',
    'run_before_final_closeout'
];
const COMPATIBILITY_TASK_RESET_KEYS = ['enabled'];

function hasExactOwnKeys(record: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
    const actualKeys = Object.keys(record).sort();
    const sortedExpectedKeys = [...expectedKeys].sort();
    return actualKeys.length === sortedExpectedKeys.length
        && sortedExpectedKeys.every((key, index) => actualKeys[index] === key);
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function getPositiveInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

function numberAtMost(record: Record<string, unknown>, key: string, limit: unknown): boolean {
    const actual = getPositiveInteger(record[key]);
    const maximum = getPositiveInteger(limit);
    return actual !== null && maximum !== null && actual <= maximum;
}

function numberEquals(record: Record<string, unknown>, key: string, expected: unknown): boolean {
    const actual = getPositiveInteger(record[key]);
    const expectedNumber = getPositiveInteger(expected);
    return actual !== null && expectedNumber !== null && actual === expectedNumber;
}

function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean))].sort();
}

function includesEvery(actual: readonly string[], expected: readonly string[]): boolean {
    const actualSet = new Set(actual);
    return expected.every((entry) => actualSet.has(entry));
}

function isSubsetOf(actual: readonly string[], allowed: readonly string[]): boolean {
    const allowedSet = new Set(allowed);
    return actual.every((entry) => allowedSet.has(entry));
}

function isSafeIgnoredWorkflowConfigCompatibilityBaseline(config: Record<string, unknown>): boolean {
    if (
        !hasExactOwnKeys(SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE as unknown as Record<string, unknown>, COMPATIBILITY_TOP_LEVEL_KEYS)
        || (
            !hasExactOwnKeys(config, COMPATIBILITY_TOP_LEVEL_KEYS)
            && !hasExactOwnKeys(config, COMPATIBILITY_PRE_TASK_RESET_TOP_LEVEL_KEYS)
            && !hasExactOwnKeys(config, COMPATIBILITY_LEGACY_REVIEW_POLICY_TOP_LEVEL_KEYS)
            && !hasExactOwnKeys(config, COMPATIBILITY_LEGACY_TOP_LEVEL_KEYS)
        )
    ) {
        return false;
    }

    const fullSuiteValidation = toPlainRecord(config.full_suite_validation);
    if (!fullSuiteValidation) {
        return false;
    }
    const outOfScopeFailurePolicy = String(
        fullSuiteValidation.out_of_scope_failure_policy || ''
    ).trim().toUpperCase();
    const command = String(fullSuiteValidation.command || '').trim();
    const defaultFullSuiteValidation = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.full_suite_validation as unknown as Record<string, unknown>;
    if (
        !hasExactOwnKeys(defaultFullSuiteValidation, COMPATIBILITY_FULL_SUITE_VALIDATION_KEYS)
        || !hasExactOwnKeys(fullSuiteValidation, COMPATIBILITY_FULL_SUITE_VALIDATION_KEYS)
        || typeof fullSuiteValidation.enabled !== 'boolean'
        || outOfScopeFailurePolicy !== 'AUDIT_AND_BLOCK'
        || !numberEquals(fullSuiteValidation, 'timeout_ms', defaultFullSuiteValidation.timeout_ms)
        || !numberEquals(fullSuiteValidation, 'green_summary_max_lines', defaultFullSuiteValidation.green_summary_max_lines)
        || !numberEquals(fullSuiteValidation, 'red_failure_chunk_lines', defaultFullSuiteValidation.red_failure_chunk_lines)
    ) {
        return false;
    }
    if (!SAFE_FULL_SUITE_COMPATIBILITY_COMMANDS.has(command)) {
        return false;
    }
    if (fullSuiteValidation.enabled === true && command !== 'npm test') {
        return false;
    }

    if (hasOwnKey(config, 'review_execution_policy')) {
        const reviewExecutionPolicy = toPlainRecord(config.review_execution_policy);
        const reviewExecutionMode = String(reviewExecutionPolicy?.mode || '').trim().toLowerCase();
        const defaultReviewExecutionPolicy = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.review_execution_policy as unknown as Record<string, unknown>;
        if (
            !reviewExecutionPolicy
            || !hasExactOwnKeys(defaultReviewExecutionPolicy, COMPATIBILITY_REVIEW_EXECUTION_POLICY_KEYS)
            || !hasExactOwnKeys(reviewExecutionPolicy, COMPATIBILITY_REVIEW_EXECUTION_POLICY_KEYS)
            || !['code_first_optional', 'strict_sequential'].includes(reviewExecutionMode)
        ) {
            return false;
        }
    }

    const scopeBudgetGuard = toPlainRecord(config.scope_budget_guard);
    const defaultScopeBudgetGuard = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.scope_budget_guard as unknown as Record<string, unknown>;
    if (
        !scopeBudgetGuard
        || !hasExactOwnKeys(defaultScopeBudgetGuard, COMPATIBILITY_SCOPE_BUDGET_GUARD_KEYS)
        || !hasExactOwnKeys(scopeBudgetGuard, COMPATIBILITY_SCOPE_BUDGET_GUARD_KEYS)
        || scopeBudgetGuard.enabled !== true
        || String(scopeBudgetGuard.action || '').trim().toUpperCase() !== 'BLOCK_FOR_SPLIT'
        || !includesEvery(
            normalizeStringList(scopeBudgetGuard.profiles),
            normalizeStringList(defaultScopeBudgetGuard.profiles)
        )
        || !numberAtMost(scopeBudgetGuard, 'max_files', defaultScopeBudgetGuard.max_files)
        || !numberAtMost(scopeBudgetGuard, 'max_changed_lines', defaultScopeBudgetGuard.max_changed_lines)
        || !numberAtMost(scopeBudgetGuard, 'max_required_reviews', defaultScopeBudgetGuard.max_required_reviews)
        || !numberAtMost(scopeBudgetGuard, 'max_review_tokens', defaultScopeBudgetGuard.max_review_tokens)
    ) {
        return false;
    }

    const reviewCycleGuard = toPlainRecord(config.review_cycle_guard);
    const defaultReviewCycleGuard = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.review_cycle_guard as unknown as Record<string, unknown>;
    if (
        !reviewCycleGuard
        || !hasExactOwnKeys(defaultReviewCycleGuard, COMPATIBILITY_REVIEW_CYCLE_GUARD_KEYS)
        || !hasExactOwnKeys(reviewCycleGuard, COMPATIBILITY_REVIEW_CYCLE_GUARD_KEYS)
        || reviewCycleGuard.enabled !== true
        || String(reviewCycleGuard.action || '').trim().toUpperCase() !== 'BLOCK_FOR_OPERATOR_DECISION'
        || !numberAtMost(reviewCycleGuard, 'max_failed_non_test_reviews', defaultReviewCycleGuard.max_failed_non_test_reviews)
        || !numberAtMost(reviewCycleGuard, 'max_total_non_test_reviews', defaultReviewCycleGuard.max_total_non_test_reviews)
        || !isSubsetOf(
            normalizeStringList(reviewCycleGuard.excluded_review_types),
            normalizeStringList(defaultReviewCycleGuard.excluded_review_types)
        )
        || reviewCycleGuard.auto_split_enabled !== defaultReviewCycleGuard.auto_split_enabled
    ) {
        return false;
    }

    const projectMemoryMaintenance = toPlainRecord(config.project_memory_maintenance);
    const defaultProjectMemoryMaintenance = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.project_memory_maintenance as unknown as Record<string, unknown>;
    const hasCurrentProjectMemoryMaintenance = !!projectMemoryMaintenance
        && projectMemoryMaintenance.enabled === true
        && String(projectMemoryMaintenance.mode || '').trim().toLowerCase() === 'update';
    const hasLegacyProjectMemoryMaintenance = isExactLegacyProjectMemoryGeneratedDefault(projectMemoryMaintenance);
    if (
        !projectMemoryMaintenance
        || !hasExactOwnKeys(defaultProjectMemoryMaintenance, COMPATIBILITY_PROJECT_MEMORY_MAINTENANCE_KEYS)
        || !hasExactOwnKeys(projectMemoryMaintenance, COMPATIBILITY_PROJECT_MEMORY_MAINTENANCE_KEYS)
        || (!hasCurrentProjectMemoryMaintenance && !hasLegacyProjectMemoryMaintenance)
        || projectMemoryMaintenance.run_before_final_closeout !== true
        || projectMemoryMaintenance.require_user_approval_for_writes !== true
        || !numberEquals(
            projectMemoryMaintenance,
            'max_compact_summary_chars',
            defaultProjectMemoryMaintenance.max_compact_summary_chars
        )
        || String(projectMemoryMaintenance.read_strategy || '').trim().toLowerCase()
            !== String(defaultProjectMemoryMaintenance.read_strategy || '').trim().toLowerCase()
        || !numberEquals(
            projectMemoryMaintenance,
            'impact_artifact_retention_days',
            defaultProjectMemoryMaintenance.impact_artifact_retention_days
        )
    ) {
        return false;
    }

    if (hasOwnKey(config, 'task_reset')) {
        const taskReset = toPlainRecord(config.task_reset);
        const defaultTaskReset = SAFE_WORKFLOW_CONFIG_COMPATIBILITY_BASELINE.task_reset as unknown as Record<string, unknown>;
        if (
            !taskReset
            || !hasExactOwnKeys(defaultTaskReset, COMPATIBILITY_TASK_RESET_KEYS)
            || !hasExactOwnKeys(taskReset, COMPATIBILITY_TASK_RESET_KEYS)
            || taskReset.enabled !== false
        ) {
            return false;
        }
    }

    return true;
}

function hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline(repoRoot: string, relativePath: string): boolean {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8'));
        const config = toPlainRecord(parsed);
        if (!config) {
            return true;
        }
        return !isSafeIgnoredWorkflowConfigCompatibilityBaseline(config);
    } catch {
        return true;
    }
}

export function getWorkflowConfigPreTaskBaselineState(
    repoRoot: string,
    currentFileHashes: Record<string, string | null> = getCurrentWorkflowConfigFileHashes(repoRoot)
): WorkflowConfigPreTaskBaselineState {
    const workflowConfigPaths = [...new Set([
        ...getWorkflowConfigControlPlanePaths(repoRoot),
        ...Object.keys(currentFileHashes)
    ])].sort();
    const manifestState = readProtectedManifestWorkflowConfigHashes(repoRoot, workflowConfigPaths);
    const manifestHashes = manifestState.hashes;
    const changedFiles = new Set<string>();
    const compatibilityBaselineFiles = new Set<string>();

    for (const relativePath of workflowConfigPaths) {
        const currentHash = Object.prototype.hasOwnProperty.call(currentFileHashes, relativePath)
            ? currentFileHashes[relativePath]
            : null;
        if (manifestState.status === 'invalid') {
            changedFiles.add(relativePath);
            continue;
        }
        const gitHeadHash = readGitHeadFileSha256(repoRoot, relativePath);
        const hasManifestHash = manifestState.status === 'present'
            && Object.prototype.hasOwnProperty.call(manifestHashes, relativePath);
        const manifestHash = hasManifestHash ? manifestHashes[relativePath] : undefined;
        const gitStatusLines = gitHeadHash === undefined && !hasManifestHash
            ? readGitIndexOrWorktreeStatus(repoRoot, relativePath)
            : [];
        if (gitStatusLines === null && currentHash !== null) {
            changedFiles.add(relativePath);
            continue;
        }
        if (gitStatusLines === null) {
            continue;
        }

        if (gitHeadHash !== undefined && gitHeadHash !== currentHash) {
            changedFiles.add(relativePath);
        }
        if (hasManifestHash && manifestHash !== currentHash) {
            changedFiles.add(relativePath);
        }
        if (
            gitHeadHash === undefined
            && !hasManifestHash
            && currentHash !== null
            && isIgnoredOnlyGitStatus(gitStatusLines)
        ) {
            if (hasUnsafeIgnoredWorkflowConfigCompatibilityBaseline(repoRoot, relativePath)) {
                changedFiles.add(relativePath);
                continue;
            }
            compatibilityBaselineFiles.add(relativePath);
            continue;
        }
        if (
            gitHeadHash === undefined
            && !hasManifestHash
            && gitStatusLines.length > 0
        ) {
            changedFiles.add(relativePath);
        }
    }

    return {
        changed_files: [...changedFiles].sort(),
        compatibility_baseline_files: [...compatibilityBaselineFiles].sort()
    };
}

function getWorkflowConfigChangedFilesFromBaseline(
    currentFileHashes: Record<string, string | null>,
    baselineFileHashes: Record<string, string | null> | null | undefined
): string[] {
    if (!baselineFileHashes || Object.keys(baselineFileHashes).length === 0) {
        return [];
    }
    const changedFiles: string[] = [];
    const allPaths = new Set([...Object.keys(baselineFileHashes), ...Object.keys(currentFileHashes)]);
    for (const relativePath of allPaths) {
        const baselineHash = Object.prototype.hasOwnProperty.call(baselineFileHashes, relativePath)
            ? baselineFileHashes[relativePath]
            : null;
        if (
            isWorkflowConfigControlPlanePathShape(relativePath)
            && baselineHash !== currentFileHashes[relativePath]
        ) {
            changedFiles.push(relativePath);
        }
    }
    return changedFiles.sort();
}

function hasWorkflowConfigHashEvidence(value: Record<string, string | null> | null | undefined): boolean {
    return !!value
        && Object.keys(value).some((relativePath) => isWorkflowConfigControlPlanePathShape(relativePath));
}

function hasPresentWorkflowConfigHashEvidence(value: Record<string, string | null> | null | undefined): boolean {
    return !!value
        && Object.entries(value).some(([relativePath, hash]) => (
            isWorkflowConfigControlPlanePathShape(relativePath)
            && typeof hash === 'string'
            && hash.length > 0
        ));
}

export function getCurrentWorkflowConfigChanges(
    repoRoot: string,
    baselineFileHashes?: Record<string, string | null> | null,
    options: {
        allowProtectedManifestFallback?: boolean;
    } = {}
): CurrentWorkflowConfigChanges {
    const currentFileHashes = getCurrentWorkflowConfigFileHashes(repoRoot);
    const workflowConfigControlPlanePaths = [
        ...new Set([
            ...Object.keys(currentFileHashes),
            ...Object.keys(baselineFileHashes || {})
        ])
    ];
    let effectiveBaselineFileHashes = hasWorkflowConfigHashEvidence(baselineFileHashes)
        ? baselineFileHashes || null
        : null;
    let baselineSource: CurrentWorkflowConfigChanges['baseline_source'] = effectiveBaselineFileHashes
        ? 'task_mode'
        : null;
    if (!effectiveBaselineFileHashes && options.allowProtectedManifestFallback !== false) {
        const manifestState = readProtectedManifestWorkflowConfigHashes(repoRoot, workflowConfigControlPlanePaths);
        if (manifestState.status === 'present' && hasWorkflowConfigHashEvidence(manifestState.hashes)) {
            effectiveBaselineFileHashes = manifestState.hashes;
            baselineSource = 'protected_manifest';
        }
    }
    const baselineChangedFiles = getWorkflowConfigChangedFilesFromBaseline(currentFileHashes, effectiveBaselineFileHashes);
    const hasBaselineFileHashes = !!effectiveBaselineFileHashes && Object.keys(effectiveBaselineFileHashes).length > 0;
    try {
        const snapshot = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], { noCache: true });
        return {
            changed_files: getWorkflowConfigChangedFiles([
                ...(hasBaselineFileHashes ? [] : snapshot.changed_files),
                ...baselineChangedFiles
            ], workflowConfigControlPlanePaths),
            current_file_hashes: currentFileHashes,
            baseline_file_hashes: effectiveBaselineFileHashes,
            baseline_source: baselineSource,
            scan_error: null
        };
    } catch (error: unknown) {
        return {
            changed_files: getWorkflowConfigChangedFiles(
                baselineChangedFiles,
                workflowConfigControlPlanePaths
            ),
            current_file_hashes: currentFileHashes,
            baseline_file_hashes: effectiveBaselineFileHashes,
            baseline_source: baselineSource,
            scan_error: error instanceof Error ? error.message : String(error)
        };
    }
}

export function getWorkflowConfigChangedFiles(
    changedFiles: readonly string[],
    allowedPaths?: readonly string[] | null
): string[] {
    const allowedPathSet = allowedPaths
        ? new Set(allowedPaths.map((entry) => normalizePath(entry)).filter(Boolean))
        : null;
    return [...new Set(
        changedFiles
            .map((entry) => String(entry || '').trim().replace(/\\/g, '/'))
            .filter((entry) => entry.length > 0)
            .filter((entry) => {
                const normalized = normalizePath(entry);
                return allowedPathSet
                    ? allowedPathSet.has(normalized)
                    : isWorkflowConfigControlPlanePath(normalized);
            })
    )].sort();
}

export function getWorkflowConfigWorkViolations(options: {
    changedFiles: readonly string[];
    taskModeEvidence: WorkflowConfigWorkEvidence;
    phaseLabel: string;
    baselineFileHashes?: Record<string, string | null> | null;
    currentFileHashes?: Record<string, string | null> | null;
}): string[] {
    const workflowConfigPathFilter = options.baselineFileHashes || options.currentFileHashes
        ? [
            ...Object.keys(options.baselineFileHashes || {}),
            ...Object.keys(options.currentFileHashes || {})
        ]
        : null;
    const changedWorkflowConfigFiles = getWorkflowConfigChangedFiles(options.changedFiles, workflowConfigPathFilter);
    if (
        !hasWorkflowConfigHashEvidence(options.baselineFileHashes)
        && hasPresentWorkflowConfigHashEvidence(options.currentFileHashes)
    ) {
        return [
            `Workflow config baseline hashes are missing before ${options.phaseLabel}. ` +
            'Re-enter task mode so workflow_config_file_hashes are captured before guarded workflow-config checks continue.'
        ];
    }

    if (changedWorkflowConfigFiles.length === 0) {
        return [];
    }

    if (
        options.taskModeEvidence.workflow_config_work === true
        && options.taskModeEvidence.orchestrator_work !== true
    ) {
        return [
            `Workflow config files changed before ${options.phaseLabel} with inconsistent task-mode evidence: ` +
            `--workflow-config-work requires --orchestrator-work: ${changedWorkflowConfigFiles.join(', ')}. ` +
            'Re-enter task mode with --orchestrator-work --workflow-config-work.'
        ];
    }

    if (
        options.taskModeEvidence.orchestrator_work === true
        && options.taskModeEvidence.workflow_config_work === true
    ) {
        return [];
    }

    if (options.taskModeEvidence.workflow_config_work === true) {
        return [
            `Workflow config files changed before ${options.phaseLabel} with --workflow-config-work but without --orchestrator-work: ` +
            `${changedWorkflowConfigFiles.join(', ')}. Re-enter task mode with --orchestrator-work --workflow-config-work.`
        ];
    }

    const flagHint = options.taskModeEvidence.orchestrator_work === true
        ? '--workflow-config-work'
        : '--orchestrator-work --workflow-config-work';
    return [
        `Workflow config files changed before ${options.phaseLabel} without task-mode ${flagHint}: ${changedWorkflowConfigFiles.join(', ')}. ` +
        `Re-enter task mode with ${flagHint} only for tasks that intentionally change workflow-config.json; workflow set audit logs do not grant task-mode permission.`
    ];
}
