import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidTaskId } from '../gate-runtime/task-events';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../core/subprocess';
import {
    PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH,
    PROJECT_MEMORY_REQUIRED_FILE_NAMES,
    PROJECT_MEMORY_RUNTIME_DIRECTORY_RELATIVE_PATH,
    resolveLiveProjectMemoryDir,
    resolveRuntimeProjectMemoryDir,
    resolveTemplateProjectMemoryDir,
    sha256Hex,
    toProjectMemoryPosixPath
} from '../core/project-memory';
import {
    buildDefaultWorkflowConfig,
    getWorkflowConfigPath,
    PROJECT_MEMORY_MAINTENANCE_MODES,
    type ProjectMemoryMaintenanceConfig,
    type ProjectMemoryMaintenanceMode
} from '../core/workflow-config';
import { resolveBundleNameForTarget } from '../core/constants';
import { isPlainObject } from '../core/config-merge';
import { validateWorkflowConfig } from '../schemas/config-artifacts';
import { validateProjectMemoryBootstrap, type ProjectMemoryValidationResult } from '../validators/project-memory';
import { fileSha256, normalizePath } from './helpers';

export type ProjectMemoryImpactStatus = 'OFF' | 'NO_UPDATE_NEEDED' | 'UPDATE_NEEDED' | 'UPDATED' | 'BLOCKED';
export type ProjectMemoryUpdateEvidenceStatus = 'NOT_REQUIRED' | 'MISSING' | 'VALID' | 'STALE' | 'TAMPERED' | 'INVALID';
export type ProjectMemoryImpactEvidenceStatus = 'NOT_REQUIRED' | 'MISSING' | 'CURRENT' | 'STALE' | 'BLOCKED' | 'INVALID';
export type ProjectMemoryChangedFilesSource = 'preflight' | 'explicit';

export const PROJECT_MEMORY_IMPACT_ASSESSED_EVENT = 'PROJECT_MEMORY_IMPACT_ASSESSED';
export const PROJECT_MEMORY_IMPACT_BLOCKED_EVENT = 'PROJECT_MEMORY_IMPACT_BLOCKED';

export interface ProjectMemoryImpactReason {
    changed_file: string;
    reason: string;
    suggested_memory_files: string[];
}

export interface ProjectMemoryImpactOptions {
    repoRoot: string;
    taskId: string;
    preflightPath?: string | null;
    changedFiles?: string[];
    confirmUpdated?: boolean;
    updatedMemoryFiles?: string[];
    modeOverride?: ProjectMemoryMaintenanceMode | null;
    artifactPath?: string | null;
    updateArtifactPath?: string | null;
}

export interface ProjectMemoryUpdateEvidence {
    schema_version: 1;
    timestamp_utc: string;
    task_id: string;
    status: 'UPDATED';
    impact_fingerprint_sha256: string;
    updated_memory_files: string[];
    updated_file_hashes: Record<string, string>;
    compact_refreshed: boolean;
    compact_sha256: string | null;
}

export interface ProjectMemoryImpactArtifact {
    schema_version: 1;
    timestamp_utc: string;
    task_id: string;
    mode: ProjectMemoryMaintenanceMode;
    configured_mode: ProjectMemoryMaintenanceMode;
    enabled: boolean;
    status: ProjectMemoryImpactStatus;
    outcome: 'PASS' | 'FAIL';
    update_needed: boolean;
    writes_allowed: false;
    require_user_approval_for_writes: boolean;
    changed_files_source: ProjectMemoryChangedFilesSource;
    preflight_path: string | null;
    preflight_hash_sha256: string | null;
    changed_files: string[];
    affected_memory_files: string[];
    affected_memory_file_names: string[];
    reasons: ProjectMemoryImpactReason[];
    validation: ProjectMemoryValidationResult;
    compact: {
        path: string;
        exists: boolean;
        char_count: number | null;
        max_chars: number;
        sha256: string | null;
        status: 'OK' | 'MISSING' | 'OVERFLOW';
    };
    update_evidence: {
        status: ProjectMemoryUpdateEvidenceStatus;
        path: string;
        updated_memory_files: string[];
        missing_updated_memory_files: string[];
        invalid_reasons: string[];
    };
    impact_fingerprint_sha256: string;
    next_step: string;
    violations: string[];
}

export interface ProjectMemoryImpactLifecycleEvidence {
    required: boolean;
    enabled: boolean;
    mode: ProjectMemoryMaintenanceMode;
    configured_mode: ProjectMemoryMaintenanceMode;
    run_before_final_closeout: boolean;
    artifact_path: string;
    update_artifact_path: string;
    status: ProjectMemoryImpactStatus | null;
    outcome: 'PASS' | 'FAIL' | null;
    evidence_status: ProjectMemoryImpactEvidenceStatus;
    update_needed: boolean | null;
    affected_memory_files: string[];
    updated_memory_files: string[];
    compact_status: 'OK' | 'MISSING' | 'OVERFLOW' | null;
    compact_refreshed: boolean | null;
    visible_summary_line: string;
    violations: string[];
}

interface ImpactRule {
    name: string;
    matches: (repoPath: string) => boolean;
    memoryFiles: readonly string[];
    reason: string;
}

const IMPACT_RULES: readonly ImpactRule[] = Object.freeze([
    Object.freeze({
        name: 'cli-command-surface',
        matches: (repoPath: string) => repoPath.startsWith('src/cli/commands/'),
        memoryFiles: Object.freeze(['commands.md', 'module-map.md', 'compact.md']),
        reason: 'Changed CLI command surface or command implementation.'
    }),
    Object.freeze({
        name: 'gate-runtime',
        matches: (repoPath: string) => repoPath.startsWith('src/gates/'),
        memoryFiles: Object.freeze(['risks.md', 'commands.md', 'decisions.md', 'compact.md']),
        reason: 'Changed gate/runtime workflow behavior.'
    }),
    Object.freeze({
        name: 'lifecycle-runtime',
        matches: (repoPath: string) => repoPath.startsWith('src/lifecycle/'),
        memoryFiles: Object.freeze(['decisions.md', 'module-map.md', 'risks.md', 'compact.md']),
        reason: 'Changed lifecycle/update/runtime maintenance behavior.'
    }),
    Object.freeze({
        name: 'materialization-runtime',
        matches: (repoPath: string) => repoPath.startsWith('src/materialization/'),
        memoryFiles: Object.freeze(['module-map.md', 'risks.md', 'compact.md']),
        reason: 'Changed materialization or project bootstrap behavior.'
    }),
    Object.freeze({
        name: 'project-memory-template',
        matches: (repoPath: string) => repoPath.startsWith('template/docs/project-memory/'),
        memoryFiles: Object.freeze(['compact.md']),
        reason: 'Changed project-memory template guidance.'
    }),
    Object.freeze({
        name: 'toolchain-config',
        matches: (repoPath: string) => repoPath === 'package.json'
            || repoPath.startsWith('tsconfig')
            || repoPath === 'package-lock.json',
        memoryFiles: Object.freeze(['stack.md', 'commands.md', 'decisions.md', 'compact.md']),
        reason: 'Changed toolchain, dependencies, or package metadata.'
    }),
    Object.freeze({
        name: 'agent-workflow-rules',
        matches: (repoPath: string) => repoPath === 'AGENTS.md'
            || repoPath === 'CLAUDE.md'
            || repoPath === 'GEMINI.md'
            || repoPath === 'QWEN.md'
            || repoPath.startsWith('.agents/workflows/')
            || repoPath.startsWith('template/docs/agent-rules/')
            || repoPath.startsWith('garda-agent-orchestrator/live/docs/agent-rules/'),
        memoryFiles: Object.freeze(['commands.md', 'decisions.md', 'compact.md']),
        reason: 'Changed agent workflow or rule entrypoint guidance.'
    }),
    Object.freeze({
        name: 'cli-reference-docs',
        matches: (repoPath: string) => repoPath === 'docs/cli-reference.md'
            || repoPath === 'README.md'
            || repoPath === 'HOW_TO.md',
        memoryFiles: Object.freeze(['commands.md', 'compact.md']),
        reason: 'Changed durable command or operator documentation.'
    })
]);

function toRepoPath(value: string): string {
    return toProjectMemoryPosixPath(value).replace(/^\.\//, '');
}

function uniqueSorted(values: Iterable<string>): string[] {
    return [...new Set([...values].filter(Boolean))].sort();
}

function readJsonFileIfPresent(filePath: string): unknown | null {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function computeProjectMemoryConfigKeyEditDistance(left: string, right: string): number {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const distances = Array.from({ length: rows }, (_, rowIndex) => (
        Array.from({ length: cols }, (_, colIndex) => (rowIndex === 0 ? colIndex : (colIndex === 0 ? rowIndex : 0)))
    ));

    for (let rowIndex = 1; rowIndex < rows; rowIndex += 1) {
        for (let colIndex = 1; colIndex < cols; colIndex += 1) {
            const substitutionCost = left[rowIndex - 1] === right[colIndex - 1] ? 0 : 1;
            distances[rowIndex][colIndex] = Math.min(
                distances[rowIndex - 1][colIndex] + 1,
                distances[rowIndex][colIndex - 1] + 1,
                distances[rowIndex - 1][colIndex - 1] + substitutionCost
            );
        }
    }

    return distances[left.length][right.length];
}

function readProjectMemoryMaintenanceSection(parsed: Record<string, unknown>, defaultConfig: ProjectMemoryMaintenanceConfig): unknown {
    const exactKey = 'project_memory_maintenance';
    if (parsed[exactKey] !== undefined) {
        return parsed[exactKey];
    }

    for (const key of Object.keys(parsed)) {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey === exactKey) {
            throw new Error(`workflow-config.${key} must use the exact key '${exactKey}'.`);
        }
        const editDistance = computeProjectMemoryConfigKeyEditDistance(normalizedKey, exactKey);
        if (editDistance > 0 && editDistance <= 2) {
            throw new Error(`workflow-config.${key} is not allowed; did you mean '${exactKey}'?`);
        }
    }

    return defaultConfig;
}

function readWorkflowProjectMemoryConfig(bundleRoot: string): ProjectMemoryMaintenanceConfig {
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    const defaultConfig = defaultWorkflowConfig.project_memory_maintenance;
    const configPath = getWorkflowConfigPath(bundleRoot);
    const parsed = readJsonFileIfPresent(configPath);
    if (!parsed) {
        return { ...defaultConfig };
    }
    const workflowConfigForProjectMemory = {
        full_suite_validation: defaultWorkflowConfig.full_suite_validation,
        review_execution_policy: defaultWorkflowConfig.review_execution_policy,
        project_memory_maintenance: isPlainObject(parsed)
            ? readProjectMemoryMaintenanceSection(parsed, defaultConfig)
            : defaultConfig
    };
    const validated = validateWorkflowConfig(workflowConfigForProjectMemory) as { project_memory_maintenance?: ProjectMemoryMaintenanceConfig };
    return {
        ...defaultConfig,
        ...(validated.project_memory_maintenance ?? {})
    };
}

function normalizeMaintenanceMode(value: unknown, fallback: ProjectMemoryMaintenanceMode): ProjectMemoryMaintenanceMode {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return fallback;
    }
    if (!PROJECT_MEMORY_MAINTENANCE_MODES.includes(normalized as ProjectMemoryMaintenanceMode)) {
        throw new Error(`Project memory mode must be one of: ${PROJECT_MEMORY_MAINTENANCE_MODES.join(', ')}.`);
    }
    return normalized as ProjectMemoryMaintenanceMode;
}

function resolveProjectMemoryRuntime(repoRoot: string, taskId: string, input?: {
    preflightPath?: string | null;
    artifactPath?: string | null;
    updateArtifactPath?: string | null;
}): {
    repoRoot: string;
    taskId: string;
    bundleRoot: string;
    config: ProjectMemoryMaintenanceConfig;
    mode: ProjectMemoryMaintenanceMode;
    configuredMode: ProjectMemoryMaintenanceMode;
    required: boolean;
    artifactPath: string;
    updateArtifactPath: string;
    preflightPath: string | null;
} {
    const resolvedRepoRoot = path.resolve(repoRoot || '.');
    const safeTaskId = assertValidTaskId(taskId);
    const bundleName = resolveBundleNameForTarget(resolvedRepoRoot);
    const bundleRoot = path.join(resolvedRepoRoot, bundleName);
    const config = readWorkflowProjectMemoryConfig(bundleRoot);
    const configuredMode = normalizeMaintenanceMode(config.mode, 'check');
    const mode = config.enabled === false ? 'off' : configuredMode;
    const runtimeMemoryDir = resolveRuntimeProjectMemoryDir(bundleRoot);
    return {
        repoRoot: resolvedRepoRoot,
        taskId: safeTaskId,
        bundleRoot,
        config,
        mode,
        configuredMode,
        required: mode !== 'off' && config.run_before_final_closeout === true,
        artifactPath: input?.artifactPath
            ? path.resolve(resolvedRepoRoot, input.artifactPath)
            : path.join(runtimeMemoryDir, `${safeTaskId}-impact.json`),
        updateArtifactPath: input?.updateArtifactPath
            ? path.resolve(resolvedRepoRoot, input.updateArtifactPath)
            : path.join(runtimeMemoryDir, `${safeTaskId}-update.json`),
        preflightPath: input?.preflightPath === null
            ? null
            : path.resolve(resolvedRepoRoot, input?.preflightPath || resolveDefaultPreflightPath(bundleRoot, safeTaskId))
    };
}

function sameJsonValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function compareImpactArtifactToExpected(
    actual: ProjectMemoryImpactArtifact,
    expected: ProjectMemoryImpactArtifact
): string[] {
    const checks: Array<{ field: string; actual: unknown; expected: unknown }> = [
        { field: 'schema_version', actual: actual.schema_version, expected: expected.schema_version },
        { field: 'task_id', actual: actual.task_id, expected: expected.task_id },
        { field: 'mode', actual: actual.mode, expected: expected.mode },
        { field: 'configured_mode', actual: actual.configured_mode, expected: expected.configured_mode },
        { field: 'enabled', actual: actual.enabled, expected: expected.enabled },
        { field: 'status', actual: actual.status, expected: expected.status },
        { field: 'outcome', actual: actual.outcome, expected: expected.outcome },
        { field: 'update_needed', actual: actual.update_needed, expected: expected.update_needed },
        { field: 'writes_allowed', actual: actual.writes_allowed, expected: expected.writes_allowed },
        {
            field: 'require_user_approval_for_writes',
            actual: actual.require_user_approval_for_writes,
            expected: expected.require_user_approval_for_writes
        },
        { field: 'changed_files_source', actual: actual.changed_files_source, expected: expected.changed_files_source },
        { field: 'preflight_path', actual: actual.preflight_path, expected: expected.preflight_path },
        { field: 'preflight_hash_sha256', actual: actual.preflight_hash_sha256, expected: expected.preflight_hash_sha256 },
        { field: 'changed_files', actual: actual.changed_files, expected: expected.changed_files },
        { field: 'affected_memory_files', actual: actual.affected_memory_files, expected: expected.affected_memory_files },
        { field: 'affected_memory_file_names', actual: actual.affected_memory_file_names, expected: expected.affected_memory_file_names },
        { field: 'reasons', actual: actual.reasons, expected: expected.reasons },
        { field: 'validation', actual: actual.validation, expected: expected.validation },
        { field: 'compact', actual: actual.compact, expected: expected.compact },
        { field: 'update_evidence', actual: actual.update_evidence, expected: expected.update_evidence },
        { field: 'impact_fingerprint_sha256', actual: actual.impact_fingerprint_sha256, expected: expected.impact_fingerprint_sha256 },
        { field: 'violations', actual: actual.violations, expected: expected.violations }
    ];
    const violations: string[] = [];
    for (const check of checks) {
        if (!sameJsonValue(check.actual, check.expected)) {
            violations.push(`Project memory impact artifact field '${check.field}' is stale or does not match current evidence.`);
        }
    }
    return violations;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isProjectMemoryMode(value: unknown): value is ProjectMemoryMaintenanceMode {
    return PROJECT_MEMORY_MAINTENANCE_MODES.includes(value as ProjectMemoryMaintenanceMode);
}

function isImpactStatus(value: unknown): value is ProjectMemoryImpactStatus {
    return ['OFF', 'NO_UPDATE_NEEDED', 'UPDATE_NEEDED', 'UPDATED', 'BLOCKED'].includes(String(value || ''));
}

function isImpactOutcome(value: unknown): value is 'PASS' | 'FAIL' {
    return value === 'PASS' || value === 'FAIL';
}

function isCompactStatus(value: unknown): value is 'OK' | 'MISSING' | 'OVERFLOW' {
    return value === 'OK' || value === 'MISSING' || value === 'OVERFLOW';
}

function isUpdateEvidenceStatus(value: unknown): value is ProjectMemoryUpdateEvidenceStatus {
    return ['NOT_REQUIRED', 'MISSING', 'VALID', 'STALE', 'TAMPERED', 'INVALID'].includes(String(value || ''));
}

function isChangedFilesSource(value: unknown): value is ProjectMemoryChangedFilesSource {
    return value === 'preflight' || value === 'explicit';
}

function validateImpactArtifactShape(parsed: Record<string, unknown>): string[] {
    const violations: string[] = [];
    const require = (condition: boolean, field: string, expected: string): void => {
        if (!condition) {
            violations.push(`Project memory impact artifact field '${field}' must be ${expected}.`);
        }
    };

    require(parsed.schema_version === 1, 'schema_version', '1');
    require(typeof parsed.timestamp_utc === 'string', 'timestamp_utc', 'a string');
    require(typeof parsed.task_id === 'string', 'task_id', 'a string');
    require(isProjectMemoryMode(parsed.mode), 'mode', `one of: ${PROJECT_MEMORY_MAINTENANCE_MODES.join(', ')}`);
    require(isProjectMemoryMode(parsed.configured_mode), 'configured_mode', `one of: ${PROJECT_MEMORY_MAINTENANCE_MODES.join(', ')}`);
    require(typeof parsed.enabled === 'boolean', 'enabled', 'a boolean');
    require(isImpactStatus(parsed.status), 'status', 'a valid project-memory impact status');
    require(isImpactOutcome(parsed.outcome), 'outcome', 'PASS or FAIL');
    require(typeof parsed.update_needed === 'boolean', 'update_needed', 'a boolean');
    require(typeof parsed.writes_allowed === 'boolean', 'writes_allowed', 'a boolean');
    require(typeof parsed.require_user_approval_for_writes === 'boolean', 'require_user_approval_for_writes', 'a boolean');
    require(isChangedFilesSource(parsed.changed_files_source), 'changed_files_source', 'preflight or explicit');
    require(isNullableString(parsed.preflight_path), 'preflight_path', 'a string or null');
    require(isNullableString(parsed.preflight_hash_sha256), 'preflight_hash_sha256', 'a string or null');
    require(isStringArray(parsed.changed_files), 'changed_files', 'an array of strings');
    require(isStringArray(parsed.affected_memory_files), 'affected_memory_files', 'an array of strings');
    require(isStringArray(parsed.affected_memory_file_names), 'affected_memory_file_names', 'an array of strings');
    require(Array.isArray(parsed.reasons), 'reasons', 'an array');
    require(isPlainObject(parsed.validation), 'validation', 'an object');

    const compact = isPlainObject(parsed.compact) ? parsed.compact : null;
    require(compact !== null, 'compact', 'an object');
    if (compact) {
        require(typeof compact.path === 'string', 'compact.path', 'a string');
        require(typeof compact.exists === 'boolean', 'compact.exists', 'a boolean');
        require(compact.char_count === null || typeof compact.char_count === 'number', 'compact.char_count', 'a number or null');
        require(typeof compact.max_chars === 'number', 'compact.max_chars', 'a number');
        require(isNullableString(compact.sha256), 'compact.sha256', 'a string or null');
        require(isCompactStatus(compact.status), 'compact.status', 'OK, MISSING, or OVERFLOW');
    }

    const updateEvidence = isPlainObject(parsed.update_evidence) ? parsed.update_evidence : null;
    require(updateEvidence !== null, 'update_evidence', 'an object');
    if (updateEvidence) {
        require(isUpdateEvidenceStatus(updateEvidence.status), 'update_evidence.status', 'a valid update evidence status');
        require(typeof updateEvidence.path === 'string', 'update_evidence.path', 'a string');
        require(isStringArray(updateEvidence.updated_memory_files), 'update_evidence.updated_memory_files', 'an array of strings');
        require(isStringArray(updateEvidence.missing_updated_memory_files), 'update_evidence.missing_updated_memory_files', 'an array of strings');
        require(isStringArray(updateEvidence.invalid_reasons), 'update_evidence.invalid_reasons', 'an array of strings');
    }

    require(typeof parsed.impact_fingerprint_sha256 === 'string', 'impact_fingerprint_sha256', 'a string');
    require(typeof parsed.next_step === 'string', 'next_step', 'a string');
    require(isStringArray(parsed.violations), 'violations', 'an array of strings');
    return violations;
}

function readImpactArtifact(artifactPath: string): {
    artifact: ProjectMemoryImpactArtifact | null;
    exists: boolean;
    invalidReasons: string[];
} {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return { artifact: null, exists: false, invalidReasons: [] };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    } catch (error: unknown) {
        return {
            artifact: null,
            exists: true,
            invalidReasons: [
                `Project memory impact artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`
            ]
        };
    }

    if (!isPlainObject(parsed)) {
        return {
            artifact: null,
            exists: true,
            invalidReasons: ['Project memory impact artifact must be a JSON object.']
        };
    }

    const invalidReasons = validateImpactArtifactShape(parsed);
    return {
        artifact: invalidReasons.length === 0 ? parsed as unknown as ProjectMemoryImpactArtifact : null,
        exists: true,
        invalidReasons
    };
}

function buildProjectMemoryVisibleSummary(input: {
    required: boolean;
    enabled: boolean;
    mode: ProjectMemoryMaintenanceMode;
    evidenceStatus: ProjectMemoryImpactEvidenceStatus;
    status: ProjectMemoryImpactStatus | null;
    updateNeeded: boolean | null;
    updatedMemoryFiles: readonly string[];
    compactStatus: string | null;
    compactRefreshed: boolean | null;
}): string {
    const statusText = input.status || input.evidenceStatus;
    const parts = [
        `Project memory: ${input.enabled ? 'enabled' : 'disabled'}`,
        `mode=${input.mode}`,
        `required=${input.required}`,
        `evidence=${input.evidenceStatus}`,
        `status=${statusText}`,
        `update_needed=${input.updateNeeded == null ? 'unknown' : input.updateNeeded}`,
        `updated_files=${input.updatedMemoryFiles.length}`,
        `compact=${input.compactStatus || 'unknown'}`,
        `compact_refreshed=${input.compactRefreshed == null ? 'unknown' : input.compactRefreshed}`
    ];
    return parts.join('; ');
}

export function getProjectMemoryImpactLifecycleEvidence(input: {
    repoRoot: string;
    taskId: string;
    preflightPath?: string | null;
    artifactPath?: string | null;
    updateArtifactPath?: string | null;
}): ProjectMemoryImpactLifecycleEvidence {
    const runtime = resolveProjectMemoryRuntime(input.repoRoot, input.taskId, input);
    if (!runtime.required) {
        const status = runtime.mode === 'off' ? 'OFF' : null;
        return {
            required: false,
            enabled: runtime.mode !== 'off',
            mode: runtime.mode,
            configured_mode: runtime.configuredMode,
            run_before_final_closeout: runtime.config.run_before_final_closeout,
            artifact_path: normalizePath(runtime.artifactPath),
            update_artifact_path: normalizePath(runtime.updateArtifactPath),
            status,
            outcome: status === 'OFF' ? 'PASS' : null,
            evidence_status: 'NOT_REQUIRED',
            update_needed: false,
            affected_memory_files: [],
            updated_memory_files: [],
            compact_status: null,
            compact_refreshed: null,
            visible_summary_line: buildProjectMemoryVisibleSummary({
                required: false,
                enabled: runtime.mode !== 'off',
                mode: runtime.mode,
                evidenceStatus: 'NOT_REQUIRED',
                status,
                updateNeeded: false,
                updatedMemoryFiles: [],
                compactStatus: null,
                compactRefreshed: null
            }),
            violations: []
        };
    }

    const expected = assessProjectMemoryImpact({
        repoRoot: runtime.repoRoot,
        taskId: runtime.taskId,
        preflightPath: runtime.preflightPath,
        artifactPath: runtime.artifactPath,
        updateArtifactPath: runtime.updateArtifactPath
    }).artifact;
    const actualResult = readImpactArtifact(runtime.artifactPath);
    const actual = actualResult.artifact;
    if (!actual) {
        const evidenceStatus: ProjectMemoryImpactEvidenceStatus = actualResult.exists ? 'INVALID' : 'MISSING';
        const violations = actualResult.exists
            ? actualResult.invalidReasons
            : [`Project memory impact artifact is missing: ${normalizePath(runtime.artifactPath)}.`];
        return {
            required: true,
            enabled: true,
            mode: runtime.mode,
            configured_mode: runtime.configuredMode,
            run_before_final_closeout: runtime.config.run_before_final_closeout,
            artifact_path: normalizePath(runtime.artifactPath),
            update_artifact_path: normalizePath(runtime.updateArtifactPath),
            status: null,
            outcome: null,
            evidence_status: evidenceStatus,
            update_needed: expected.update_needed,
            affected_memory_files: expected.affected_memory_files,
            updated_memory_files: expected.update_evidence.updated_memory_files,
            compact_status: expected.compact.status,
            compact_refreshed: null,
            visible_summary_line: buildProjectMemoryVisibleSummary({
                required: true,
                enabled: true,
                mode: runtime.mode,
                evidenceStatus,
                status: null,
                updateNeeded: expected.update_needed,
                updatedMemoryFiles: expected.update_evidence.updated_memory_files,
                compactStatus: expected.compact.status,
                compactRefreshed: null
            }),
            violations
        };
    }

    const violations = compareImpactArtifactToExpected(actual, expected);
    const evidenceStatus: ProjectMemoryImpactEvidenceStatus = violations.length > 0
        ? 'STALE'
        : actual.status === 'BLOCKED'
            ? 'BLOCKED'
            : actual.outcome === 'PASS'
                ? 'CURRENT'
                : 'INVALID';
    const compactRefreshed = actual.update_evidence.status === 'NOT_REQUIRED'
        ? false
        : readUpdateEvidence(runtime.updateArtifactPath)?.compact_refreshed ?? null;
    return {
        required: true,
        enabled: true,
        mode: actual.mode,
        configured_mode: actual.configured_mode,
        run_before_final_closeout: runtime.config.run_before_final_closeout,
        artifact_path: normalizePath(runtime.artifactPath),
        update_artifact_path: normalizePath(runtime.updateArtifactPath),
        status: actual.status,
        outcome: actual.outcome,
        evidence_status: evidenceStatus,
        update_needed: actual.update_needed,
        affected_memory_files: actual.affected_memory_files,
        updated_memory_files: actual.update_evidence.updated_memory_files,
        compact_status: actual.compact.status,
        compact_refreshed: compactRefreshed,
        visible_summary_line: buildProjectMemoryVisibleSummary({
            required: true,
            enabled: true,
            mode: actual.mode,
            evidenceStatus,
            status: actual.status,
            updateNeeded: actual.update_needed,
            updatedMemoryFiles: actual.update_evidence.updated_memory_files,
            compactStatus: actual.compact.status,
            compactRefreshed
        }),
        violations
    };
}

function resolveDefaultPreflightPath(bundleRoot: string, taskId: string): string {
    return path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-preflight.json`);
}

function readPreflightChangedFiles(preflightPath: string | null): {
    changedFiles: string[];
    preflightHash: string | null;
    readable: boolean;
    invalidReason: string | null;
} {
    if (!preflightPath || !fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return {
            changedFiles: [],
            preflightHash: null,
            readable: false,
            invalidReason: preflightPath ? 'Preflight artifact is missing.' : 'Preflight artifact path is not set.'
        };
    }
    const parsed = readJsonFileIfPresent(preflightPath);
    if (!isPlainObject(parsed)) {
        return {
            changedFiles: [],
            preflightHash: fileSha256(preflightPath),
            readable: false,
            invalidReason: 'Preflight artifact is not valid JSON object evidence.'
        };
    }
    const changed = Array.isArray(parsed.changed_files)
        ? parsed.changed_files.map((value) => String(value || '')).filter(Boolean)
        : [];
    return {
        changedFiles: changed,
        preflightHash: fileSha256(preflightPath),
        readable: true,
        invalidReason: null
    };
}

function appendTemplateCorrespondingFile(repoPath: string, files: Set<string>): void {
    const prefix = 'template/docs/project-memory/';
    if (!repoPath.startsWith(prefix)) {
        return;
    }
    const fileName = repoPath.slice(prefix.length);
    if ((PROJECT_MEMORY_REQUIRED_FILE_NAMES as readonly string[]).includes(fileName)) {
        files.add(fileName);
    }
}

export function routeProjectMemoryImpact(changedFiles: readonly string[]): {
    affectedFileNames: string[];
    reasons: ProjectMemoryImpactReason[];
} {
    const affected = new Set<string>();
    const reasons: ProjectMemoryImpactReason[] = [];

    for (const rawFile of changedFiles) {
        const repoPath = toRepoPath(rawFile);
        if (!repoPath || repoPath.startsWith(`${PROJECT_MEMORY_RUNTIME_DIRECTORY_RELATIVE_PATH}/`)) {
            continue;
        }
        if (repoPath.startsWith(PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH + '/')) {
            continue;
        }
        if (repoPath.startsWith('tests/') || repoPath.includes('/fixtures/')) {
            continue;
        }

        const fileReasons = new Set<string>();
        const fileSuggestions = new Set<string>();
        for (const rule of IMPACT_RULES) {
            if (!rule.matches(repoPath)) {
                continue;
            }
            for (const fileName of rule.memoryFiles) {
                fileSuggestions.add(fileName);
                affected.add(fileName);
            }
            fileReasons.add(rule.reason);
        }
        appendTemplateCorrespondingFile(repoPath, fileSuggestions);
        appendTemplateCorrespondingFile(repoPath, affected);

        if (fileSuggestions.size > 0) {
            reasons.push({
                changed_file: repoPath,
                reason: uniqueSorted(fileReasons).join(' '),
                suggested_memory_files: uniqueSorted(fileSuggestions)
            });
        }
    }

    return {
        affectedFileNames: uniqueSorted(affected),
        reasons
    };
}

function buildAffectedMemoryPaths(bundleName: string, fileNames: readonly string[]): string[] {
    return fileNames.map((fileName) =>
        toRepoPath(path.posix.join(bundleName, PROJECT_MEMORY_LIVE_DIRECTORY_RELATIVE_PATH, fileName))
    );
}

function readCompactState(memoryDir: string, maxChars: number): ProjectMemoryImpactArtifact['compact'] {
    const compactPath = path.join(memoryDir, 'compact.md');
    if (!fs.existsSync(compactPath) || !fs.statSync(compactPath).isFile()) {
        return {
            path: normalizePath(compactPath),
            exists: false,
            char_count: null,
            max_chars: maxChars,
            sha256: null,
            status: 'MISSING'
        };
    }
    const content = fs.readFileSync(compactPath, 'utf8');
    return {
        path: normalizePath(compactPath),
        exists: true,
        char_count: content.length,
        max_chars: maxChars,
        sha256: sha256Hex(content),
        status: content.length > maxChars ? 'OVERFLOW' : 'OK'
    };
}

function buildImpactFingerprint(input: {
    taskId: string;
    preflightHash: string | null;
    changedFiles: string[];
    affectedMemoryFiles: string[];
    reasons: ProjectMemoryImpactReason[];
}): string {
    return sha256Hex(JSON.stringify({
        task_id: input.taskId,
        preflight_hash_sha256: input.preflightHash,
        changed_files: input.changedFiles,
        affected_memory_files: input.affectedMemoryFiles,
        reasons: input.reasons
    }));
}

function isPathInside(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeUpdatedMemoryFile(repoRoot: string, bundleRoot: string, value: string): string {
    const raw = String(value || '').trim();
    if (!raw) {
        throw new Error('Updated memory file path must not be empty.');
    }
    const liveMemoryDir = resolveLiveProjectMemoryDir(bundleRoot);
    let fullPath: string;
    if ((PROJECT_MEMORY_REQUIRED_FILE_NAMES as readonly string[]).includes(raw)) {
        fullPath = path.join(liveMemoryDir, raw);
    } else {
        fullPath = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repoRoot, raw);
    }
    if (!isPathInside(liveMemoryDir, fullPath)) {
        throw new Error(`Updated memory file must be under ${toRepoPath(path.relative(repoRoot, liveMemoryDir))}: ${raw}`);
    }
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        throw new Error(`Updated memory file does not exist: ${raw}`);
    }
    return toRepoPath(path.relative(repoRoot, fullPath));
}

function hashUpdatedMemoryFiles(repoRoot: string, updatedMemoryFiles: readonly string[]): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const repoPath of updatedMemoryFiles) {
        hashes[repoPath] = fileSha256(path.join(repoRoot, repoPath)) ?? '';
    }
    return hashes;
}

function buildMissingUpdatedFiles(
    affectedMemoryFiles: readonly string[],
    updatedMemoryFiles: readonly string[]
): string[] {
    const updated = new Set(updatedMemoryFiles);
    return affectedMemoryFiles.filter((file) => !updated.has(file));
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function collectChangedProjectMemoryFiles(repoRoot: string, bundleRoot: string): { files: string[]; error: string | null } {
    const liveMemoryDir = resolveLiveProjectMemoryDir(bundleRoot);
    const repoRelativeMemoryDir = toRepoPath(path.relative(repoRoot, liveMemoryDir));
    const result = spawnSyncWithTimeout('git', [
        '-C',
        repoRoot,
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        '--',
        `:(literal)${repoRelativeMemoryDir}`
    ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.timedOut || result.error || result.status !== 0) {
        const reason = result.timedOut
            ? `timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
            : result.error
                ? String(result.error)
                : String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
        return {
            files: [],
            error: `git status could not inspect current project-memory changes (${reason}).`
        };
    }

    const files = new Set<string>();
    const parts = String(result.stdout || '').split('\0').filter((part) => part.length > 0);
    for (let index = 0; index < parts.length; index += 1) {
        const line = parts[index];
        if (line.length < 4) {
            continue;
        }
        const normalizedPath = normalizePath(line.slice(3));
        if (!normalizedPath.startsWith(`${repoRelativeMemoryDir}/`)) {
            if ((line[0] === 'R' || line[0] === 'C') && index + 1 < parts.length) {
                index += 1;
            }
            continue;
        }
        files.add(normalizedPath);
        if ((line[0] === 'R' || line[0] === 'C') && index + 1 < parts.length) {
            index += 1;
        }
    }

    return {
        files: [...files].sort(),
        error: null
    };
}

function resolveUpdatedMemoryFilesForConfirmation(input: {
    repoRoot: string;
    bundleRoot: string;
    affectedMemoryFiles: string[];
    explicitUpdatedMemoryFiles: string[];
}): { updatedMemoryFiles: string[]; inferenceViolation: string | null } {
    const explicitUpdatedMemoryFiles = input.explicitUpdatedMemoryFiles
        .map((file) => String(file || '').trim())
        .filter(Boolean);
    if (explicitUpdatedMemoryFiles.length > 0 || input.affectedMemoryFiles.length === 0) {
        return {
            updatedMemoryFiles: explicitUpdatedMemoryFiles,
            inferenceViolation: null
        };
    }

    const inferred = collectChangedProjectMemoryFiles(input.repoRoot, input.bundleRoot);
    if (inferred.error) {
        return {
            updatedMemoryFiles: [],
            inferenceViolation: 'No --updated-memory-file values were provided, and the current project-memory diff could not be inferred safely.'
        };
    }
    if (!arraysEqual(inferred.files, input.affectedMemoryFiles)) {
        const changedSummary = inferred.files.length > 0 ? inferred.files.join(', ') : '(none)';
        return {
            updatedMemoryFiles: [],
            inferenceViolation: `No --updated-memory-file values were provided, and the current changed project-memory files do not exactly match the affected list. Changed project-memory files: ${changedSummary}.`
        };
    }
    return {
        updatedMemoryFiles: inferred.files,
        inferenceViolation: null
    };
}

function readUpdateEvidence(updateArtifactPath: string): ProjectMemoryUpdateEvidence | null {
    const parsed = readJsonFileIfPresent(updateArtifactPath);
    if (!isPlainObject(parsed)) {
        return null;
    }
    if (parsed.schema_version !== 1 || parsed.status !== 'UPDATED') {
        return null;
    }
    return parsed as unknown as ProjectMemoryUpdateEvidence;
}

function validateExistingUpdateEvidence(input: {
    repoRoot: string;
    updateArtifactPath: string;
    impactFingerprint: string;
    affectedMemoryFiles: string[];
}): ProjectMemoryImpactArtifact['update_evidence'] {
    const evidence = readUpdateEvidence(input.updateArtifactPath);
    if (!evidence) {
        return {
            status: 'MISSING',
            path: normalizePath(input.updateArtifactPath),
            updated_memory_files: [],
            missing_updated_memory_files: input.affectedMemoryFiles,
            invalid_reasons: ['Update evidence is missing or invalid.']
        };
    }
    const updatedMemoryFiles = Array.isArray(evidence.updated_memory_files)
        ? evidence.updated_memory_files.map((file) => toRepoPath(String(file || ''))).filter(Boolean)
        : [];
    const missingUpdated = buildMissingUpdatedFiles(input.affectedMemoryFiles, updatedMemoryFiles);
    const invalidReasons: string[] = [];
    let status: ProjectMemoryUpdateEvidenceStatus = 'VALID';

    if (evidence.impact_fingerprint_sha256 !== input.impactFingerprint) {
        status = 'STALE';
        invalidReasons.push('Update evidence is bound to a different impact fingerprint.');
    }
    if (missingUpdated.length > 0) {
        status = 'STALE';
        invalidReasons.push(`Update evidence is missing affected memory files: ${missingUpdated.join(', ')}.`);
    }
    const expectedHashes = isPlainObject(evidence.updated_file_hashes)
        ? evidence.updated_file_hashes as Record<string, unknown>
        : {};
    for (const repoPath of updatedMemoryFiles) {
        const fullPath = path.join(input.repoRoot, repoPath);
        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
            status = 'TAMPERED';
            invalidReasons.push(`Updated memory file no longer exists: ${repoPath}.`);
            continue;
        }
        const expectedHash = String(expectedHashes[repoPath] || '');
        const actualHash = fileSha256(fullPath);
        if (!expectedHash || expectedHash !== actualHash) {
            status = 'TAMPERED';
            invalidReasons.push(`Updated memory file hash changed after evidence was recorded: ${repoPath}.`);
        }
    }

    return {
        status,
        path: normalizePath(input.updateArtifactPath),
        updated_memory_files: updatedMemoryFiles,
        missing_updated_memory_files: missingUpdated,
        invalid_reasons: invalidReasons
    };
}

function buildUpdateEvidence(input: {
    repoRoot: string;
    bundleRoot: string;
    taskId: string;
    impactFingerprint: string;
    affectedMemoryFiles: string[];
    updatedMemoryFiles: string[];
    compactSha256: string | null;
}): { evidence: ProjectMemoryUpdateEvidence; updateEvidence: ProjectMemoryImpactArtifact['update_evidence']; violations: string[] } {
    const violations: string[] = [];
    const resolvedUpdatedMemoryFiles = resolveUpdatedMemoryFilesForConfirmation({
        repoRoot: input.repoRoot,
        bundleRoot: input.bundleRoot,
        affectedMemoryFiles: input.affectedMemoryFiles,
        explicitUpdatedMemoryFiles: input.updatedMemoryFiles
    });
    if (resolvedUpdatedMemoryFiles.inferenceViolation) {
        violations.push(resolvedUpdatedMemoryFiles.inferenceViolation);
    }
    const normalizedUpdatedFiles: string[] = [];
    for (const rawFile of resolvedUpdatedMemoryFiles.updatedMemoryFiles) {
        try {
            normalizedUpdatedFiles.push(normalizeUpdatedMemoryFile(input.repoRoot, input.bundleRoot, rawFile));
        } catch (error: unknown) {
            violations.push(error instanceof Error ? error.message : String(error));
        }
    }
    const updatedMemoryFiles = uniqueSorted(normalizedUpdatedFiles);
    const missingUpdated = buildMissingUpdatedFiles(input.affectedMemoryFiles, updatedMemoryFiles);
    if (input.affectedMemoryFiles.length > 0 && missingUpdated.length > 0) {
        violations.push(`Confirmed update evidence is missing affected memory files: ${missingUpdated.join(', ')}.`);
    }
    const hashes = hashUpdatedMemoryFiles(input.repoRoot, updatedMemoryFiles);
    const evidence: ProjectMemoryUpdateEvidence = {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        task_id: input.taskId,
        status: 'UPDATED',
        impact_fingerprint_sha256: input.impactFingerprint,
        updated_memory_files: updatedMemoryFiles,
        updated_file_hashes: hashes,
        compact_refreshed: updatedMemoryFiles.some((file) => file.endsWith('/compact.md')),
        compact_sha256: input.compactSha256
    };
    return {
        evidence,
        updateEvidence: {
            status: violations.length > 0 ? 'INVALID' : 'VALID',
            path: '',
            updated_memory_files: updatedMemoryFiles,
            missing_updated_memory_files: missingUpdated,
            invalid_reasons: violations
        },
        violations
    };
}

function buildNextStep(status: ProjectMemoryImpactStatus, affectedMemoryFiles: readonly string[]): string {
    switch (status) {
        case 'OFF':
            return 'Project memory maintenance is disabled; no memory evidence is required.';
        case 'NO_UPDATE_NEEDED':
            return 'No durable project-memory update is required for the current changed-file scope.';
        case 'UPDATED':
            return 'Project memory update evidence is current for the affected memory files.';
        case 'BLOCKED':
            return 'With explicit user approval, update the listed memory files and rerun project-memory-impact with --confirm-updated, or switch maintenance mode out of strict/update.';
        case 'UPDATE_NEEDED':
        default:
            return affectedMemoryFiles.length > 0
                ? 'With explicit user approval, update listed memory files when appropriate, then rerun with --confirm-updated; check mode remains advisory.'
                : 'Inspect project-memory diagnostics; check mode remains advisory.';
    }
}

export function assessProjectMemoryImpact(options: ProjectMemoryImpactOptions): {
    artifact: ProjectMemoryImpactArtifact;
    updateEvidenceToWrite: ProjectMemoryUpdateEvidence | null;
    artifactPath: string;
    updateArtifactPath: string;
} {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(options.taskId);
    const bundleName = resolveBundleNameForTarget(repoRoot);
    const bundleRoot = path.join(repoRoot, bundleName);
    const configured = readWorkflowProjectMemoryConfig(bundleRoot);
    const configuredMode = normalizeMaintenanceMode(configured.mode, 'check');
    const mode = options.modeOverride
        ? normalizeMaintenanceMode(options.modeOverride, configuredMode)
        : configured.enabled === false
            ? 'off'
            : configuredMode;
    const liveMemoryDir = resolveLiveProjectMemoryDir(bundleRoot);
    const templateMemoryDir = resolveTemplateProjectMemoryDir(bundleRoot);
    const runtimeMemoryDir = resolveRuntimeProjectMemoryDir(bundleRoot);
    const artifactPath = options.artifactPath
        ? path.resolve(repoRoot, options.artifactPath)
        : path.join(runtimeMemoryDir, `${taskId}-impact.json`);
    const updateArtifactPath = options.updateArtifactPath
        ? path.resolve(repoRoot, options.updateArtifactPath)
        : path.join(runtimeMemoryDir, `${taskId}-update.json`);
    const preflightPath = options.preflightPath === null
        ? null
        : path.resolve(repoRoot, options.preflightPath || resolveDefaultPreflightPath(bundleRoot, taskId));
    const preflight = readPreflightChangedFiles(preflightPath);
    const explicitChangedFilesProvided = Array.isArray(options.changedFiles);
    const changedFiles = uniqueSorted(explicitChangedFilesProvided
        ? (options.changedFiles || []).map(toRepoPath)
        : preflight.changedFiles.map(toRepoPath));
    const routed = routeProjectMemoryImpact(changedFiles);
    const affectedMemoryFileNames = routed.affectedFileNames;
    const affectedMemoryFiles = buildAffectedMemoryPaths(bundleName, affectedMemoryFileNames);
    const validationMode = mode === 'strict' ? 'strict' : 'check';
    const validation = validateProjectMemoryBootstrap(liveMemoryDir, {
        mode: validationMode,
        templateProjectMemoryDir: templateMemoryDir,
        maxCompactSummaryChars: configured.max_compact_summary_chars
    });
    const compact = readCompactState(liveMemoryDir, configured.max_compact_summary_chars);
    const impactFingerprint = buildImpactFingerprint({
        taskId,
        preflightHash: preflight.preflightHash,
        changedFiles,
        affectedMemoryFiles,
        reasons: routed.reasons
    });
    const updateNeeded = affectedMemoryFiles.length > 0;
    let updateEvidence: ProjectMemoryImpactArtifact['update_evidence'] = updateNeeded
        ? validateExistingUpdateEvidence({
            repoRoot,
            updateArtifactPath,
            impactFingerprint,
            affectedMemoryFiles
        })
        : {
            status: 'NOT_REQUIRED',
            path: normalizePath(updateArtifactPath),
            updated_memory_files: [],
            missing_updated_memory_files: [],
            invalid_reasons: []
        };
    let updateEvidenceToWrite: ProjectMemoryUpdateEvidence | null = null;
    const violations: string[] = [];

    if (options.confirmUpdated === true) {
        const built = buildUpdateEvidence({
            repoRoot,
            bundleRoot,
            taskId,
            impactFingerprint,
            affectedMemoryFiles,
            updatedMemoryFiles: options.updatedMemoryFiles || [],
            compactSha256: compact.sha256
        });
        updateEvidenceToWrite = built.violations.length === 0 ? built.evidence : null;
        updateEvidence = {
            ...built.updateEvidence,
            path: normalizePath(updateArtifactPath)
        };
        violations.push(...built.violations);
    }

    if (mode !== 'off' && !explicitChangedFilesProvided && !preflight.readable) {
        violations.push(preflight.invalidReason || 'Preflight artifact could not be read.');
    }

    let status: ProjectMemoryImpactStatus;
    if (mode === 'off') {
        status = 'OFF';
    } else if (violations.length > 0) {
        status = 'BLOCKED';
    } else if (updateEvidence.status === 'VALID' && updateNeeded) {
        status = 'UPDATED';
    } else if (updateNeeded) {
        status = mode === 'strict' || mode === 'update' ? 'BLOCKED' : 'UPDATE_NEEDED';
        if (mode === 'strict' || mode === 'update') {
            violations.push(...updateEvidence.invalid_reasons);
        }
    } else {
        status = 'NO_UPDATE_NEEDED';
    }

    const artifact: ProjectMemoryImpactArtifact = {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        task_id: taskId,
        mode,
        configured_mode: configuredMode,
        enabled: mode !== 'off',
        status,
        outcome: status === 'BLOCKED' ? 'FAIL' : 'PASS',
        update_needed: status === 'UPDATE_NEEDED' || status === 'BLOCKED',
        writes_allowed: false,
        require_user_approval_for_writes: configured.require_user_approval_for_writes,
        changed_files_source: explicitChangedFilesProvided ? 'explicit' : 'preflight',
        preflight_path: preflightPath ? normalizePath(preflightPath) : null,
        preflight_hash_sha256: preflight.preflightHash,
        changed_files: changedFiles,
        affected_memory_files: affectedMemoryFiles,
        affected_memory_file_names: affectedMemoryFileNames,
        reasons: routed.reasons,
        validation,
        compact,
        update_evidence: updateEvidence,
        impact_fingerprint_sha256: impactFingerprint,
        next_step: buildNextStep(status, affectedMemoryFiles),
        violations
    };

    return {
        artifact,
        updateEvidenceToWrite,
        artifactPath,
        updateArtifactPath
    };
}
