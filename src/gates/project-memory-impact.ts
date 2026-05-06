import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidTaskId } from '../gate-runtime/task-events';
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

function readWorkflowProjectMemoryConfig(bundleRoot: string): ProjectMemoryMaintenanceConfig {
    const defaultConfig = buildDefaultWorkflowConfig().project_memory_maintenance;
    const configPath = getWorkflowConfigPath(bundleRoot);
    const parsed = readJsonFileIfPresent(configPath);
    if (!parsed) {
        return { ...defaultConfig };
    }
    const validated = validateWorkflowConfig(parsed) as { project_memory_maintenance?: ProjectMemoryMaintenanceConfig };
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
    const normalizedUpdatedFiles: string[] = [];
    for (const rawFile of input.updatedMemoryFiles) {
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
            return 'Update the listed memory files and rerun project-memory-impact with --confirm-updated, or switch maintenance mode out of strict.';
        case 'UPDATE_NEEDED':
        default:
            return affectedMemoryFiles.length > 0
                ? 'Update listed memory files when appropriate, then rerun with --confirm-updated; check mode remains advisory.'
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
