import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    withTaskQueueStatusSyncLock
} from '../../cli/commands/gate-flows/task/task-queue-sync';
import {
    formatActiveTaskQueueTable,
    parseCanonicalActiveTaskQueue,
    replaceTaskMdTableCell
} from '../../core/task-md-table';
import {
    formatTaskQueueStatusCell,
    readTaskQueueStatusToken
} from '../../core/task-queue/active-task-state';
import {
    appendMandatoryTaskEvent
} from '../../gate-runtime/task-events';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    materializeSplitRequiredLatch
} from '../next-step/next-step-split-required-latch';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';

const REPAIR_ARTIFACT_SCHEMA_VERSION = 1;
const WIP_MANIFEST_SCHEMA_VERSION = 1;

export interface FullSuiteRepairTaskProposal {
    suggested_task_id: string;
    title: string;
    area: string;
    rationale: string;
}

interface RepairTaskProposalReadResult {
    proposal: FullSuiteRepairTaskProposal | null;
    violations: string[];
}

export interface FullSuiteRepairTaskMaterializationResult {
    status: 'MATERIALIZED' | 'ALREADY_MATERIALIZED' | 'BLOCKED';
    task_id: string;
    child_task_id: string | null;
    artifact_path: string;
    wip_manifest_path: string | null;
    split_required_artifact_path: string | null;
    violations: string[];
    output_lines: string[];
}

export interface FullSuiteRepairWipRestoreResult {
    status: 'RESTORED' | 'DRY_RUN_OK' | 'BLOCKED';
    manifest_path: string;
    restored_files: string[];
    violations: string[];
    output_lines: string[];
}

interface CapturedPatchEvidence {
    path: string;
    sha256: string;
    bytes: number;
    empty: boolean;
}

interface CapturedTrackedFileEvidence {
    path: string;
    head_sha256: string | null;
    worktree_sha256: string | null;
    staged: boolean;
    unstaged: boolean;
}

interface CapturedUntrackedFileEvidence {
    path: string;
    artifact_path: string;
    sha256: string;
    bytes: number;
}

interface RepairWipManifest {
    schema_version: number;
    kind: 'full_suite_repair_wip';
    status: 'suspended';
    task_id: string;
    child_task_id: string;
    created_at_utc: string;
    base_commit: string;
    preflight_path: string;
    preflight_sha256: string;
    full_suite_artifact_path: string;
    full_suite_artifact_sha256: string;
    patches: {
        staged: CapturedPatchEvidence;
        unstaged: CapturedPatchEvidence;
    };
    tracked_files: CapturedTrackedFileEvidence[];
    untracked_files: CapturedUntrackedFileEvidence[];
    unrelated_untracked_files: string[];
}

interface TaskQueueRowsMaterializationResult {
    outcome: string;
    task_path: string;
    parent_linked: boolean;
    child_created: boolean;
    error_message: string | null;
}

interface ParentResumeStatusResult {
    outcome: 'updated' | 'already_synced' | 'task_file_missing' | 'task_not_found' | 'blocked_status' | 'write_failed';
    task_path: string;
    task_id: string;
    previous_status: string | null;
    next_status: 'IN_PROGRESS';
    error_message: string | null;
}

interface TrackedChangeFiles {
    staged: Set<string>;
    unstaged: Set<string>;
    all: string[];
}

interface PreflightChangedFileScope {
    allowed: Set<string>;
    violations: string[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nowIso(): string {
    return new Date().toISOString();
}

function stableTimestampSlug(timestampUtc: string): string {
    return timestampUtc.replace(/[^0-9A-Za-z]+/gu, '-').replace(/^-|-$/gu, '');
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function sha256FileRequired(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function validateTaskTableTextField(value: unknown, fieldName: string): { value: string | null; violations: string[] } {
    const text = String(value || '').trim();
    const violations: string[] = [];
    if (!text) {
        violations.push(`repair_task_proposal.${fieldName} must not be empty.`);
        return { value: null, violations };
    }
    if (/[\u0000-\u001F\u007F|]/u.test(text)) {
        violations.push(`repair_task_proposal.${fieldName} must not contain control characters or Markdown table delimiters.`);
        return { value: null, violations };
    }
    return { value: text, violations };
}

function validateRepairChildTaskId(value: unknown, parentTaskId: string): { value: string | null; violations: string[] } {
    const text = String(value || '').trim();
    if (!text) {
        return {
            value: null,
            violations: ['repair_task_proposal.suggested_task_id must not be empty.']
        };
    }
    const expectedPattern = new RegExp(`^${escapeRegExp(parentTaskId)}-F[1-9][0-9]*$`, 'u');
    if (!expectedPattern.test(text)) {
        return {
            value: null,
            violations: [`repair_task_proposal.suggested_task_id must match ${parentTaskId}-F<number>.`]
        };
    }
    return { value: text, violations: [] };
}

function fileBytes(filePath: string): number {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? fs.statSync(filePath).size
        : 0;
}

function runGit(repoRoot: string, args: string[], options: { allowFailure?: boolean } = {}): string {
    try {
        return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (error: unknown) {
        if (options.allowFailure) {
            return '';
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`git ${args.join(' ')} failed: ${message}`);
    }
}

function runGitBinary(repoRoot: string, args: string[]): Buffer {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function splitNulList(value: string | Buffer): string[] {
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : value;
    return text.split('\0').map((entry) => entry.trim()).filter(Boolean);
}

function normalizeGitPath(value: string): string {
    return value.replace(/\\/gu, '/').replace(/^\/+/u, '');
}

function resolveRepoPath(repoRoot: string, relativePath: string): string {
    const normalized = normalizeGitPath(relativePath);
    const resolved = path.resolve(repoRoot, normalized);
    const root = path.resolve(repoRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Path escapes repo root: ${relativePath}`);
    }
    return resolved;
}

function resolveInputPathInsideRepo(repoRoot: string, inputPath: string, label: string): string {
    const rawPath = String(inputPath || '').trim();
    if (!rawPath) {
        throw new Error(`${label} must not be empty.`);
    }
    const resolved = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(repoRoot, rawPath);
    const root = path.resolve(repoRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`${label} escapes repo root: ${inputPath}`);
    }
    return resolved;
}

function getHeadCommit(repoRoot: string): string {
    return runGit(repoRoot, ['rev-parse', 'HEAD']).trim();
}

function pathExistsInHead(repoRoot: string, relativePath: string): boolean {
    const normalized = normalizeGitPath(relativePath);
    const result = childProcess.spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `HEAD:${normalized}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return result.status === 0;
}

function headBlobSha(repoRoot: string, relativePath: string): string | null {
    const normalized = normalizeGitPath(relativePath);
    const output = runGit(repoRoot, ['rev-parse', `HEAD:${normalized}`], { allowFailure: true }).trim();
    return output || null;
}

function collectTrackedChangeFiles(repoRoot: string): TrackedChangeFiles {
    const staged = new Set(splitNulList(runGitBinary(repoRoot, ['diff', '--name-only', '--cached', '-z'])).map(normalizeGitPath));
    const unstaged = new Set(splitNulList(runGitBinary(repoRoot, ['diff', '--name-only', '-z'])).map(normalizeGitPath));
    return {
        staged,
        unstaged,
        all: [...new Set([...staged, ...unstaged])].sort()
    };
}

function readPreflightChangedFileScope(repoRoot: string, preflightPath: string, expectedTaskId: string): PreflightChangedFileScope {
    const artifact = safeReadJson(preflightPath);
    const violations: string[] = [];
    const allowed = new Set<string>();
    if (!isPlainRecord(artifact)) {
        return {
            allowed,
            violations: ['Preflight artifact is missing or invalid.']
        };
    }
    const artifactTaskId = typeof artifact.task_id === 'string' ? artifact.task_id.trim() : '';
    if (artifactTaskId && artifactTaskId !== expectedTaskId) {
        violations.push(`Preflight task_id mismatch: expected ${expectedTaskId}; found ${artifactTaskId}.`);
    }
    if (!Array.isArray(artifact.changed_files)) {
        violations.push('Preflight changed_files must be an array.');
        return { allowed, violations };
    }
    for (const entry of artifact.changed_files) {
        if (typeof entry !== 'string' || !entry.trim()) {
            violations.push('Preflight changed_files contains an invalid path.');
            continue;
        }
        try {
            const resolved = resolveRepoPath(repoRoot, entry.trim());
            const relativePath = normalizeGitPath(path.relative(path.resolve(repoRoot), resolved));
            if (!relativePath) {
                violations.push('Preflight changed_files contains an invalid empty path.');
                continue;
            }
            allowed.add(relativePath);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`Preflight changed_files path invalid: ${message}`);
        }
    }
    return { allowed, violations };
}

function findOutOfScopeTrackedChanges(trackedChanges: TrackedChangeFiles, allowedScope: Set<string>): string[] {
    return trackedChanges.all.filter((relativePath) => !allowedScope.has(relativePath));
}

function collectVisibleUntrackedFiles(repoRoot: string): string[] {
    return splitNulList(runGitBinary(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']))
        .map(normalizeGitPath)
        .sort();
}

function collectUntrackedFilesForPathspecs(repoRoot: string, pathspecs: string[], includeIgnored: boolean): string[] {
    const normalizedPathspecs = [...new Set(pathspecs.map(normalizeGitPath).filter(Boolean))].sort();
    if (normalizedPathspecs.length === 0) {
        return [];
    }
    const visibleUntracked = splitNulList(runGitBinary(repoRoot, [
        'ls-files',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        ...normalizedPathspecs
    ]));
    const ignoredUntracked = includeIgnored
        ? splitNulList(runGitBinary(repoRoot, [
            'ls-files',
            '--others',
            '--ignored',
            '--exclude-standard',
            '-z',
            '--',
            ...normalizedPathspecs
        ]))
        : [];
    return [...new Set([...visibleUntracked, ...ignoredUntracked].map(normalizeGitPath))].sort();
}

function collectRuntimeTmpTaskOwnedUntrackedFiles(repoRoot: string, taskId: string): string[] {
    return collectUntrackedFilesForPathspecs(
        repoRoot,
        ['garda-agent-orchestrator/runtime/tmp'],
        true
    ).filter((relativePath) => isTaskOwnedUntrackedPath(relativePath, taskId));
}

function isTaskOwnedUntrackedPath(relativePath: string, taskId: string): boolean {
    const normalized = normalizeGitPath(relativePath);
    const taskToken = taskId.toLowerCase();
    const lower = normalized.toLowerCase();
    const hasTaskIdToken = lower.includes(`/${taskToken}/`)
        || lower.includes(`/${taskToken}-`)
        || lower.endsWith(`/${taskToken}.md`)
        || lower.endsWith(`/${taskToken}.json`)
        || lower.endsWith(`/${taskToken}.jsonl`);
    if (!hasTaskIdToken) {
        return false;
    }
    if (!lower.startsWith('garda-agent-orchestrator/runtime/tmp/')) {
        return false;
    }
    return true;
}

function buildPatchEvidence(filePath: string): CapturedPatchEvidence {
    return {
        path: normalizePath(filePath),
        sha256: sha256FileRequired(filePath),
        bytes: fileBytes(filePath),
        empty: fileBytes(filePath) === 0
    };
}

function writePatchFile(repoRoot: string, args: string[], outputPath: string): CapturedPatchEvidence {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const output = runGit(repoRoot, args);
    fs.writeFileSync(outputPath, output, 'utf8');
    return buildPatchEvidence(outputPath);
}

function writeEmptyPatchFile(outputPath: string): CapturedPatchEvidence {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, '', 'utf8');
    return buildPatchEvidence(outputPath);
}

function writeScopedPatchFile(repoRoot: string, diffArgs: string[], relativePaths: Set<string>, outputPath: string): CapturedPatchEvidence {
    const sortedPaths = [...relativePaths].sort();
    if (sortedPaths.length === 0) {
        return writeEmptyPatchFile(outputPath);
    }
    return writePatchFile(repoRoot, [...diffArgs, '--', ...sortedPaths], outputPath);
}

function copyUntrackedTaskFile(repoRoot: string, captureRoot: string, relativePath: string): CapturedUntrackedFileEvidence {
    const sourcePath = resolveRepoPath(repoRoot, relativePath);
    const artifactPath = path.join(captureRoot, 'untracked', normalizeGitPath(relativePath));
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.copyFileSync(sourcePath, artifactPath);
    return {
        path: normalizeGitPath(relativePath),
        artifact_path: normalizePath(artifactPath),
        sha256: sha256FileRequired(artifactPath),
        bytes: fileBytes(artifactPath)
    };
}

function removeFileIfExists(filePath: string): void {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
    }
}

function suspendTrackedChanges(repoRoot: string, changedFiles: string[]): void {
    if (changedFiles.length === 0) {
        return;
    }
    const trackedAtHead = new Map(changedFiles.map((relativePath) => [
        relativePath,
        pathExistsInHead(repoRoot, relativePath)
    ]));
    runGit(repoRoot, ['reset', '--quiet', 'HEAD', '--', ...changedFiles]);
    const headTrackedFiles = changedFiles.filter((relativePath) => trackedAtHead.get(relativePath));
    if (headTrackedFiles.length > 0) {
        runGit(repoRoot, ['checkout', '--quiet', '--', ...headTrackedFiles]);
    }
    for (const relativePath of changedFiles) {
        if (trackedAtHead.get(relativePath)) {
            continue;
        }
        removeFileIfExists(resolveRepoPath(repoRoot, relativePath));
    }
}

function captureAndSuspendWip(params: {
    repoRoot: string;
    taskId: string;
    childTaskId: string;
    captureRoot: string;
    timestampUtc: string;
    preflightPath: string;
    fullSuiteArtifactPath: string;
    trackedChanges: TrackedChangeFiles;
    allowedUntrackedFiles: Set<string>;
    unrelatedVisibleUntrackedFiles: string[];
}): RepairWipManifest {
    const timestampUtc = params.timestampUtc;
    const captureRoot = params.captureRoot;
    fs.mkdirSync(captureRoot, { recursive: true });

    const scopedUntrackedFiles = collectUntrackedFilesForPathspecs(
        params.repoRoot,
        [...params.allowedUntrackedFiles],
        true
    );
    const capturedUntrackedFiles = [...new Set([
        ...collectRuntimeTmpTaskOwnedUntrackedFiles(params.repoRoot, params.taskId),
        ...scopedUntrackedFiles
    ])].sort();

    const stagedPatch = writeScopedPatchFile(params.repoRoot, ['diff', '--binary', '--cached'], params.trackedChanges.staged, path.join(captureRoot, 'staged.patch'));
    const unstagedPatch = writeScopedPatchFile(params.repoRoot, ['diff', '--binary'], params.trackedChanges.unstaged, path.join(captureRoot, 'unstaged.patch'));
    const untracked = capturedUntrackedFiles.map((relativePath) => copyUntrackedTaskFile(params.repoRoot, captureRoot, relativePath));
    const trackedFiles = params.trackedChanges.all.map((relativePath) => {
        const absolutePath = resolveRepoPath(params.repoRoot, relativePath);
        return {
            path: relativePath,
            head_sha256: headBlobSha(params.repoRoot, relativePath),
            worktree_sha256: fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()
                ? sha256FileRequired(absolutePath)
                : null,
            staged: params.trackedChanges.staged.has(relativePath),
            unstaged: params.trackedChanges.unstaged.has(relativePath)
        };
    });

    const manifest: RepairWipManifest = {
        schema_version: WIP_MANIFEST_SCHEMA_VERSION,
        kind: 'full_suite_repair_wip',
        status: 'suspended',
        task_id: params.taskId,
        child_task_id: params.childTaskId,
        created_at_utc: timestampUtc,
        base_commit: getHeadCommit(params.repoRoot),
        preflight_path: normalizePath(params.preflightPath),
        preflight_sha256: fileSha256(params.preflightPath) || '',
        full_suite_artifact_path: normalizePath(params.fullSuiteArtifactPath),
        full_suite_artifact_sha256: fileSha256(params.fullSuiteArtifactPath) || '',
        patches: {
            staged: stagedPatch,
            unstaged: unstagedPatch
        },
        tracked_files: trackedFiles,
        untracked_files: untracked,
        unrelated_untracked_files: params.unrelatedVisibleUntrackedFiles
    };
    writeJson(path.join(captureRoot, 'manifest.json'), manifest);

    suspendTrackedChanges(params.repoRoot, params.trackedChanges.all);
    for (const relativePath of capturedUntrackedFiles) {
        removeFileIfExists(resolveRepoPath(params.repoRoot, relativePath));
    }

    return manifest;
}

function planWipCaptureLocation(repoRoot: string, taskId: string): { timestampUtc: string; captureRoot: string; manifestPath: string } {
    const timestampUtc = nowIso();
    const captureRoot = joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'wip', taskId, 'full-suite-repair', stableTimestampSlug(timestampUtc))
    );
    return {
        timestampUtc,
        captureRoot,
        manifestPath: path.join(captureRoot, 'manifest.json')
    };
}

function readRepairTaskProposal(fullSuiteArtifactPath: string, parentTaskId: string): RepairTaskProposalReadResult {
    const artifact = safeReadJson(fullSuiteArtifactPath);
    const timeoutPolicy = isPlainRecord(artifact?.timeout_policy) ? artifact.timeout_policy : null;
    const proposal = isPlainRecord(timeoutPolicy?.repair_task_proposal)
        ? timeoutPolicy.repair_task_proposal
        : null;
    if (!proposal) {
        return {
            proposal: null,
            violations: ['Current full-suite artifact has no structured timeout repair_task_proposal.']
        };
    }
    const childTaskId = validateRepairChildTaskId(proposal.suggested_task_id, parentTaskId);
    const title = validateTaskTableTextField(proposal.title, 'title');
    const area = validateTaskTableTextField(proposal.area, 'area');
    const rationale = validateTaskTableTextField(proposal.rationale, 'rationale');
    const violations = [
        ...childTaskId.violations,
        ...title.violations,
        ...area.violations,
        ...rationale.violations
    ];
    if (violations.length > 0 || !childTaskId.value || !title.value || !area.value || !rationale.value) {
        return { proposal: null, violations };
    }
    return {
        proposal: {
            suggested_task_id: childTaskId.value,
            title: title.value,
            area: area.value,
            rationale: rationale.value
        },
        violations: []
    };
}

export function resolveFullSuiteRepairTaskArtifactPath(reviewsRoot: string, taskId: string): string {
    return path.join(reviewsRoot, `${taskId}-full-suite-repair-task.json`);
}

export function readFullSuiteRepairTaskMaterializationEvidence(params: {
    repoRoot?: string;
    reviewsRoot: string;
    taskId: string;
    fullSuiteArtifactPath: string;
    childTaskId: string | null;
}): { materialized: boolean; reason: string; artifact_path: string; child_task_id?: string | null; wip_manifest_path?: string | null } {
    const artifactPath = resolveFullSuiteRepairTaskArtifactPath(params.reviewsRoot, params.taskId);
    const artifact = safeReadJson(artifactPath);
    if (!isPlainRecord(artifact)) {
        return {
            materialized: false,
            reason: `full-suite repair materialization artifact is missing at ${normalizePath(artifactPath)}`,
            artifact_path: normalizePath(artifactPath)
        };
    }
    if (artifact.task_id !== params.taskId) {
        return { materialized: false, reason: 'full-suite repair artifact task_id mismatch', artifact_path: normalizePath(artifactPath) };
    }
    if (params.childTaskId && artifact.child_task_id !== params.childTaskId) {
        return { materialized: false, reason: 'full-suite repair artifact child_task_id mismatch', artifact_path: normalizePath(artifactPath) };
    }
    if (artifact.status !== 'MATERIALIZED') {
        return { materialized: false, reason: 'full-suite repair artifact status is not MATERIALIZED', artifact_path: normalizePath(artifactPath) };
    }
    const expectedFullSuiteSha = fileSha256(params.fullSuiteArtifactPath);
    if (!expectedFullSuiteSha || artifact.full_suite_artifact_sha256 !== expectedFullSuiteSha) {
        return { materialized: false, reason: 'full-suite repair artifact is not bound to the current full-suite artifact', artifact_path: normalizePath(artifactPath) };
    }
    let manifestPath = String(artifact.wip_manifest_path || '');
    if (params.repoRoot) {
        try {
            manifestPath = resolveInputPathInsideRepo(params.repoRoot, manifestPath, 'WipManifestPath');
        } catch {
            return { materialized: false, reason: 'full-suite repair WIP manifest path escapes repo root', artifact_path: normalizePath(artifactPath) };
        }
    }
    const expectedManifestSha = String(artifact.wip_manifest_sha256 || '').trim();
    const actualManifestSha = fileSha256(manifestPath);
    if (!expectedManifestSha || actualManifestSha !== expectedManifestSha) {
        return { materialized: false, reason: 'full-suite repair WIP manifest sha256 mismatch', artifact_path: normalizePath(artifactPath) };
    }
    const manifest = safeReadJson(manifestPath);
    if (!isPlainRecord(manifest) || manifest.kind !== 'full_suite_repair_wip' || manifest.status !== 'suspended') {
        return { materialized: false, reason: 'full-suite repair WIP manifest is missing or not suspended', artifact_path: normalizePath(artifactPath) };
    }
    if (manifest.task_id !== params.taskId) {
        return { materialized: false, reason: 'full-suite repair WIP manifest task_id mismatch', artifact_path: normalizePath(artifactPath) };
    }
    if (params.childTaskId && manifest.child_task_id !== params.childTaskId) {
        return { materialized: false, reason: 'full-suite repair WIP manifest child_task_id mismatch', artifact_path: normalizePath(artifactPath) };
    }
    if (manifest.full_suite_artifact_sha256 !== expectedFullSuiteSha) {
        return { materialized: false, reason: 'full-suite repair WIP manifest is not bound to the current full-suite artifact', artifact_path: normalizePath(artifactPath) };
    }
    return {
        materialized: true,
        reason: 'full-suite repair task and WIP manifest are materialized',
        artifact_path: normalizePath(artifactPath),
        child_task_id: String(artifact.child_task_id || ''),
        wip_manifest_path: normalizePath(manifestPath)
    };
}

function appendChildLinkNote(existingNotes: string, childTaskId: string, manifestPath: string): string {
    if (existingNotes.includes(childTaskId)) {
        return existingNotes;
    }
    const suffix = `Created child tasks: \`${childTaskId}\`; parent WIP suspended at \`${normalizePath(manifestPath)}\`.`;
    return existingNotes.trim() ? `${existingNotes.trim()} ${suffix}` : suffix;
}

function materializeTaskQueueRows(params: {
    repoRoot: string;
    parentTaskId: string;
    proposal: FullSuiteRepairTaskProposal;
    manifestPath: string;
}): TaskQueueRowsMaterializationResult {
    const taskPath = path.join(params.repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: normalizePath(taskPath),
            parent_linked: false,
            child_created: false,
            error_message: null
        };
    }
    return withTaskQueueStatusSyncLock<TaskQueueRowsMaterializationResult>(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            parent_linked: false,
            child_created: false,
            error_message: message
        }),
        () => {
            const original = fs.readFileSync(taskPath, 'utf8');
            const newline = original.includes('\r\n') ? '\r\n' : '\n';
            const lines = original.split(/\r?\n/);
            const parsed = parseCanonicalActiveTaskQueue(original);
            const parentRow = parsed.rows.find((row) => row.taskId === params.parentTaskId);
            if (!parentRow) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    parent_linked: false,
                    child_created: false,
                    error_message: null
                };
            }
            const childExists = parsed.rows.some((row) => row.taskId === params.proposal.suggested_task_id);
            const nextNotes = appendChildLinkNote(parentRow.notes, params.proposal.suggested_task_id, params.manifestPath);
            let parentLinked = false;
            const updatedParentLine = replaceTaskMdTableCell(parentRow.rawLine, 8, ` ${nextNotes} `);
            if (updatedParentLine && updatedParentLine !== parentRow.rawLine) {
                lines[parentRow.lineIndex] = updatedParentLine;
                parentLinked = true;
            }

            let childCreated = false;
            if (!childExists) {
                const today = nowIso().slice(0, 10);
                const childNotes = `Child of \`${params.parentTaskId}\`. Repair full-suite timeout blocker. Restore parent WIP from \`${normalizePath(params.manifestPath)}\` after child completion.`;
                const row = [
                    params.proposal.suggested_task_id,
                    'TODO',
                    parentRow.priority || 'P1',
                    params.proposal.area,
                    params.proposal.title,
                    parentRow.owner || 'gpt-5.5',
                    today,
                    'strict',
                    childNotes
                ];
                const childLine = `| ${row.join(' | ')} |`;
                lines.splice(parentRow.lineIndex + 1, 0, childLine);
                childCreated = true;
            }

            const nextContent = formatActiveTaskQueueTable(lines.join(newline));
            if (nextContent !== original) {
                fs.writeFileSync(taskPath, nextContent, 'utf8');
            }
            return {
                outcome: childCreated || parentLinked ? 'updated' : 'already_synced',
                task_path: normalizePath(taskPath),
                parent_linked: parentLinked,
                child_created: childCreated,
                error_message: null
            };
        }
    );
}

export function materializeFullSuiteRepairTask(params: {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    fullSuiteArtifactPath?: string;
    reviewsRoot?: string;
}): FullSuiteRepairTaskMaterializationResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    const reviewsRoot = params.reviewsRoot
        ? resolveInputPathInsideRepo(repoRoot, params.reviewsRoot, 'ReviewsRoot')
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const fullSuiteArtifactPath = params.fullSuiteArtifactPath
        ? resolveInputPathInsideRepo(repoRoot, params.fullSuiteArtifactPath, 'FullSuiteArtifactPath')
        : path.join(reviewsRoot, `${params.taskId}-full-suite-validation.json`);
    const preflightPath = resolveInputPathInsideRepo(repoRoot, params.preflightPath, 'PreflightPath');
    const artifactPath = resolveFullSuiteRepairTaskArtifactPath(reviewsRoot, params.taskId);
    const proposalResult = readRepairTaskProposal(fullSuiteArtifactPath, params.taskId);
    const violations: string[] = [...proposalResult.violations];
    const proposal = proposalResult.proposal;
    if (!proposal) {
        return {
            status: 'BLOCKED',
            task_id: params.taskId,
            child_task_id: null,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: null,
            split_required_artifact_path: null,
            violations,
            output_lines: ['FULL_SUITE_REPAIR_TASK_BLOCKED', ...violations.map((violation) => `Violation: ${violation}`)]
        };
    }
    const currentEvidence = readFullSuiteRepairTaskMaterializationEvidence({
        repoRoot,
        reviewsRoot,
        taskId: params.taskId,
        fullSuiteArtifactPath,
        childTaskId: proposal.suggested_task_id
    });
    if (currentEvidence.materialized) {
        return {
            status: 'ALREADY_MATERIALIZED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: String(safeReadJson(artifactPath)?.wip_manifest_path || ''),
            split_required_artifact_path: String(safeReadJson(artifactPath)?.split_required_artifact_path || ''),
            violations: [],
            output_lines: [
                'FULL_SUITE_REPAIR_TASK_ALREADY_MATERIALIZED',
                `ChildTaskId: ${proposal.suggested_task_id}`,
                `ArtifactPath: ${normalizePath(artifactPath)}`,
                `Reason: ${currentEvidence.reason}`
            ]
        };
    }
    const preflightScope = readPreflightChangedFileScope(repoRoot, preflightPath, params.taskId);
    const trackedChanges = collectTrackedChangeFiles(repoRoot);
    const outOfScopeTrackedChanges = findOutOfScopeTrackedChanges(trackedChanges, preflightScope.allowed);
    const unrelatedVisibleUntrackedFiles = collectVisibleUntrackedFiles(repoRoot)
        .filter((relativePath) => (
            !isTaskOwnedUntrackedPath(relativePath, params.taskId)
            && !preflightScope.allowed.has(relativePath)
        ));
    const scopeViolations = [...preflightScope.violations];
    if (outOfScopeTrackedChanges.length > 0) {
        scopeViolations.push(`tracked changes outside current preflight scope: ${outOfScopeTrackedChanges.join(', ')}`);
    }
    if (unrelatedVisibleUntrackedFiles.length > 0) {
        scopeViolations.push(`unrelated untracked files would keep repair scope dirty: ${unrelatedVisibleUntrackedFiles.join(', ')}`);
    }
    if (scopeViolations.length > 0) {
        return {
            status: 'BLOCKED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: null,
            split_required_artifact_path: null,
            violations: scopeViolations,
            output_lines: [
                'FULL_SUITE_REPAIR_TASK_BLOCKED',
                `TaskId: ${params.taskId}`,
                `ChildTaskId: ${proposal.suggested_task_id}`,
                `ArtifactPath: ${normalizePath(artifactPath)}`,
                ...scopeViolations.map((violation) => `Violation: ${violation}`)
            ]
        };
    }

    const wipCapture = planWipCaptureLocation(repoRoot, params.taskId);
    const queueResult = materializeTaskQueueRows({
        repoRoot,
        parentTaskId: params.taskId,
        proposal,
        manifestPath: wipCapture.manifestPath
    });
    if (queueResult.outcome === 'task_file_missing' || queueResult.outcome === 'task_not_found' || queueResult.outcome === 'write_failed') {
        violations.push(`TASK.md repair child materialization failed: ${queueResult.outcome}${queueResult.error_message ? ` (${queueResult.error_message})` : ''}.`);
    }

    let latchResult: ReturnType<typeof materializeSplitRequiredLatch> | null = null;
    if (violations.length === 0) {
        latchResult = materializeSplitRequiredLatch({
            repoRoot,
            eventsRoot: joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events')),
            reviewsRoot,
            taskId: params.taskId,
            guardKind: 'full_suite_repair',
            guardReason: 'Full-suite timeout blocker exhausted retry policy and requires repair child scope.',
            rawGuardSummary: proposal.rationale,
            preflightPath,
            guardDetails: {
                repair_child_task_id: proposal.suggested_task_id,
                full_suite_artifact_path: normalizePath(fullSuiteArtifactPath),
                wip_manifest_path: normalizePath(wipCapture.manifestPath)
            }
        });
        if (latchResult.status_sync.outcome === 'task_file_missing'
            || latchResult.status_sync.outcome === 'task_not_found'
            || latchResult.status_sync.outcome === 'write_failed') {
            violations.push(`Split-required latch failed: ${latchResult.status_sync.outcome}${latchResult.status_sync.error_message ? ` (${latchResult.status_sync.error_message})` : ''}.`);
        }
    }

    if (violations.length > 0) {
        const blockedArtifact = {
            schema_version: REPAIR_ARTIFACT_SCHEMA_VERSION,
            status: 'BLOCKED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            created_at_utc: wipCapture.timestampUtc,
            proposal,
            preflight_path: normalizePath(preflightPath),
            preflight_sha256: fileSha256(preflightPath),
            full_suite_artifact_path: normalizePath(fullSuiteArtifactPath),
            full_suite_artifact_sha256: fileSha256(fullSuiteArtifactPath),
            wip_manifest_path: null,
            wip_manifest_sha256: null,
            split_required_artifact_path: latchResult?.artifact_path || null,
            split_required_artifact_sha256: latchResult?.artifact_sha256 || null,
            task_queue: queueResult,
            violations
        };
        writeJson(artifactPath, blockedArtifact);
        appendMandatoryTaskEvent(
            joinOrchestratorPath(repoRoot, ''),
            params.taskId,
            'FULL_SUITE_REPAIR_TASK_MATERIALIZED',
            'FAIL',
            'Full-suite timeout repair task materialization failed before parent WIP suspension.',
            {
                artifact_path: normalizePath(artifactPath),
                artifact_sha256: sha256Text(`${JSON.stringify(blockedArtifact, null, 2)}\n`),
                child_task_id: proposal.suggested_task_id,
                wip_manifest_path: null,
                split_required_artifact_path: latchResult?.artifact_path || null,
                violations
            },
            { actor: 'orchestrator' }
        );
        return {
            status: 'BLOCKED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: null,
            split_required_artifact_path: latchResult?.artifact_path || null,
            violations,
            output_lines: [
                'FULL_SUITE_REPAIR_TASK_BLOCKED',
                `TaskId: ${params.taskId}`,
                `ChildTaskId: ${proposal.suggested_task_id}`,
                `ArtifactPath: ${normalizePath(artifactPath)}`,
                ...violations.map((violation) => `Violation: ${violation}`)
            ]
        };
    }

    if (!latchResult) {
        throw new Error('full-suite repair split-required latch result missing after successful durable preconditions');
    }

    captureAndSuspendWip({
        repoRoot,
        taskId: params.taskId,
        childTaskId: proposal.suggested_task_id,
        captureRoot: wipCapture.captureRoot,
        timestampUtc: wipCapture.timestampUtc,
        preflightPath,
        fullSuiteArtifactPath,
        trackedChanges,
        allowedUntrackedFiles: preflightScope.allowed,
        unrelatedVisibleUntrackedFiles
    });
    const manifestPath = wipCapture.manifestPath;
    const materializationArtifact = {
        schema_version: REPAIR_ARTIFACT_SCHEMA_VERSION,
        status: 'MATERIALIZED',
        task_id: params.taskId,
        child_task_id: proposal.suggested_task_id,
        created_at_utc: nowIso(),
        proposal,
        preflight_path: normalizePath(preflightPath),
        preflight_sha256: fileSha256(preflightPath),
        full_suite_artifact_path: normalizePath(fullSuiteArtifactPath),
        full_suite_artifact_sha256: fileSha256(fullSuiteArtifactPath),
        wip_manifest_path: normalizePath(manifestPath),
        wip_manifest_sha256: sha256FileRequired(manifestPath),
        split_required_artifact_path: latchResult.artifact_path,
        split_required_artifact_sha256: latchResult.artifact_sha256,
        task_queue: queueResult,
        violations
    };
    writeJson(artifactPath, materializationArtifact);
    appendMandatoryTaskEvent(
        joinOrchestratorPath(repoRoot, ''),
        params.taskId,
        'FULL_SUITE_REPAIR_TASK_MATERIALIZED',
        violations.length === 0 ? 'BLOCKED' : 'FAIL',
        violations.length === 0
            ? 'Full-suite timeout repair task materialized and parent WIP suspended.'
            : 'Full-suite timeout repair task materialization failed.',
        {
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: sha256Text(`${JSON.stringify(materializationArtifact, null, 2)}\n`),
            child_task_id: proposal.suggested_task_id,
            wip_manifest_path: normalizePath(manifestPath),
            split_required_artifact_path: latchResult.artifact_path,
            violations
        },
        { actor: 'orchestrator' }
    );

    const status = 'MATERIALIZED';
    return {
        status,
        task_id: params.taskId,
        child_task_id: proposal.suggested_task_id,
        artifact_path: normalizePath(artifactPath),
        wip_manifest_path: normalizePath(manifestPath),
        split_required_artifact_path: latchResult.artifact_path,
        violations,
        output_lines: [
            status === 'MATERIALIZED' ? 'FULL_SUITE_REPAIR_TASK_MATERIALIZED' : 'FULL_SUITE_REPAIR_TASK_BLOCKED',
            `TaskId: ${params.taskId}`,
            `ChildTaskId: ${proposal.suggested_task_id}`,
            `ArtifactPath: ${normalizePath(artifactPath)}`,
            `WipManifestPath: ${normalizePath(manifestPath)}`,
            `SplitRequiredArtifactPath: ${latchResult.artifact_path}`,
            ...violations.map((violation) => `Violation: ${violation}`),
            `NextAction: run node bin/garda.js next-step "${params.taskId}" --repo-root "."; parent routing should continue via the repair child.`
        ]
    };
}

function hasPatchContent(patch: CapturedPatchEvidence): boolean {
    return patch.bytes > 0 && !patch.empty;
}

function ensureCleanTrackedWorkspace(repoRoot: string): string[] {
    const violations: string[] = [];
    const unstaged = runGit(repoRoot, ['diff', '--name-only']).trim();
    const staged = runGit(repoRoot, ['diff', '--name-only', '--cached']).trim();
    if (unstaged) {
        violations.push(`unstaged tracked changes exist: ${unstaged.replace(/\r?\n/gu, ', ')}`);
    }
    if (staged) {
        violations.push(`staged changes exist: ${staged.replace(/\r?\n/gu, ', ')}`);
    }
    return violations;
}

function validateManifestFileReferences(repoRoot: string, manifest: RepairWipManifest): string[] {
    const violations: string[] = [];
    if (!isPlainRecord(manifest.patches)
        || !isPlainRecord(manifest.patches.staged)
        || !isPlainRecord(manifest.patches.unstaged)) {
        return ['WIP manifest patch references are missing or invalid.'];
    }
    const validateArtifactHash = (label: string, artifactPath: string, expectedSha256: string): void => {
        if (!expectedSha256) {
            violations.push(`${label} sha256 is missing.`);
            return;
        }
        if (!fs.existsSync(artifactPath)) {
            violations.push(`${label} artifact is missing: ${normalizePath(artifactPath)}`);
            return;
        }
        if (!fs.statSync(artifactPath).isFile()) {
            violations.push(`${label} artifact is not a file: ${normalizePath(artifactPath)}`);
            return;
        }
        const actualSha256 = sha256FileRequired(artifactPath);
        if (actualSha256 !== expectedSha256) {
            violations.push(`${label} sha256 mismatch: expected=${expectedSha256}; actual=${actualSha256}`);
        }
    };
    for (const [label, patch] of [
        ['staged patch', manifest.patches.staged],
        ['unstaged patch', manifest.patches.unstaged]
    ] as const) {
        try {
            const patchPath = resolveInputPathInsideRepo(repoRoot, patch.path, label);
            validateArtifactHash(label, patchPath, patch.sha256);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(message);
        }
    }
    for (const entry of manifest.untracked_files || []) {
        try {
            const artifactPath = resolveInputPathInsideRepo(repoRoot, entry.artifact_path, `untracked artifact ${entry.path}`);
            validateArtifactHash(`untracked artifact ${entry.path}`, artifactPath, entry.sha256);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(message);
        }
    }
    return violations;
}

function isParentResumeStatus(status: string | null): boolean {
    return status === 'SPLIT_REQUIRED' || status === 'DECOMPOSED' || status === 'IN_PROGRESS';
}

function resumeParentTaskAfterWipRestore(repoRoot: string, taskId: string): ParentResumeStatusResult {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: 'IN_PROGRESS',
            error_message: null
        };
    }

    return withTaskQueueStatusSyncLock<ParentResumeStatusResult>(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: 'IN_PROGRESS',
            error_message: message
        }),
        () => {
            const original = fs.readFileSync(taskPath, 'utf8');
            const newline = original.includes('\r\n') ? '\r\n' : '\n';
            const lines = original.split(/\r?\n/);
            const row = parseCanonicalActiveTaskQueue(original).rows.find((candidate) => candidate.taskId === taskId);
            if (!row) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: null,
                    next_status: 'IN_PROGRESS',
                    error_message: null
                };
            }
            const previousStatus = readTaskQueueStatusToken(row.status);
            if (!isParentResumeStatus(previousStatus)) {
                return {
                    outcome: 'blocked_status',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'IN_PROGRESS',
                    error_message: `Expected parent status SPLIT_REQUIRED, DECOMPOSED, or IN_PROGRESS; found ${previousStatus || 'unknown'}.`
                };
            }
            if (previousStatus === 'IN_PROGRESS') {
                return {
                    outcome: 'already_synced',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'IN_PROGRESS',
                    error_message: null
                };
            }
            const updatedStatusCell = formatTaskQueueStatusCell(row.cells[1].raw, 'IN_PROGRESS');
            const updatedLine = replaceTaskMdTableCell(row.rawLine, 1, updatedStatusCell);
            if (!updatedLine) {
                return {
                    outcome: 'write_failed',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'IN_PROGRESS',
                    error_message: 'Failed to replace TASK.md status cell.'
                };
            }
            lines[row.lineIndex] = updatedLine;
            fs.writeFileSync(taskPath, formatActiveTaskQueueTable(lines.join(newline)), 'utf8');
            return {
                outcome: 'updated',
                task_path: normalizePath(taskPath),
                task_id: taskId,
                previous_status: previousStatus,
                next_status: 'IN_PROGRESS',
                error_message: null
            };
        }
    );
}

function validateParentCanResumeAfterWipRestore(repoRoot: string, taskId: string): string[] {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return [`parent status sync precheck failed: task_file_missing (${normalizePath(taskPath)}).`];
    }
    const row = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8')).rows.find((candidate) => candidate.taskId === taskId);
    if (!row) {
        return [`parent status sync precheck failed: task_not_found (${taskId}).`];
    }
    const previousStatus = readTaskQueueStatusToken(row.status);
    if (!isParentResumeStatus(previousStatus)) {
        return [`parent status sync precheck failed: blocked_status (Expected parent status SPLIT_REQUIRED, DECOMPOSED, or IN_PROGRESS; found ${previousStatus || 'unknown'}.)`];
    }
    return [];
}

function validateRepairChildDone(repoRoot: string, childTaskId: string): string[] {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const normalizedChildTaskId = childTaskId.trim();
    if (!normalizedChildTaskId) {
        return ['Repair child task id is missing from the WIP manifest.'];
    }
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return [`repair child completion check failed: TASK.md missing at ${normalizePath(taskPath)}.`];
    }
    const row = parseCanonicalActiveTaskQueue(fs.readFileSync(taskPath, 'utf8'))
        .rows
        .find((candidate) => candidate.taskId === normalizedChildTaskId);
    if (!row) {
        return [`repair child ${normalizedChildTaskId} is missing from TASK.md.`];
    }
    const status = readTaskQueueStatusToken(row.status);
    if (status !== 'DONE') {
        return [`repair child ${normalizedChildTaskId} must be DONE before restoring parent WIP; found ${status || 'unknown'}.`];
    }
    return [];
}

export function restoreFullSuiteRepairWip(params: {
    repoRoot: string;
    taskId: string;
    fullSuiteArtifactPath: string;
    manifestPath: string;
    childTaskId?: string | null;
    reviewsRoot?: string;
    dryRun?: boolean;
}): FullSuiteRepairWipRestoreResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    let manifestPath = '';
    let fullSuiteArtifactPath = '';
    let reviewsRoot = '';
    try {
        manifestPath = resolveInputPathInsideRepo(repoRoot, params.manifestPath, 'ManifestPath');
        fullSuiteArtifactPath = resolveInputPathInsideRepo(repoRoot, params.fullSuiteArtifactPath, 'FullSuiteArtifactPath');
        reviewsRoot = params.reviewsRoot
            ? resolveInputPathInsideRepo(repoRoot, params.reviewsRoot, 'ReviewsRoot')
            : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(path.resolve(repoRoot, String(params.manifestPath || ''))),
            restored_files: [],
            violations: [message],
            output_lines: ['FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED', `Violation: ${message}`]
        };
    }
    const taskId = String(params.taskId || '').trim();
    const violations: string[] = [];
    if (!taskId) {
        violations.push('TaskId must not be empty.');
    } else {
        const materializationEvidence = readFullSuiteRepairTaskMaterializationEvidence({
            repoRoot,
            reviewsRoot,
            taskId,
            fullSuiteArtifactPath,
            childTaskId: params.childTaskId || null
        });
        if (!materializationEvidence.materialized || !materializationEvidence.wip_manifest_path) {
            violations.push(`current full-suite repair materialization evidence is not valid: ${materializationEvidence.reason}`);
        } else {
            const evidenceManifestPath = resolveInputPathInsideRepo(repoRoot, materializationEvidence.wip_manifest_path, 'WipManifestPath');
            if (normalizePath(evidenceManifestPath) !== normalizePath(manifestPath)) {
                violations.push('ManifestPath is not the current materialized full-suite repair WIP manifest.');
            }
        }
    }
    const manifest = safeReadJson(manifestPath) as RepairWipManifest | null;
    if (!isPlainRecord(manifest) || manifest.kind !== 'full_suite_repair_wip') {
        violations.push('WIP manifest is missing or invalid.');
    }
    if (isPlainRecord(manifest) && manifest.kind === 'full_suite_repair_wip') {
        violations.push(...validateRepairChildDone(repoRoot, String(manifest.child_task_id || '')));
        violations.push(...validateParentCanResumeAfterWipRestore(repoRoot, String(manifest.task_id || '')));
    }
    if (manifest && manifest.base_commit && getHeadCommit(repoRoot) !== manifest.base_commit) {
        violations.push(`stale base commit: manifest=${manifest.base_commit}; current=${getHeadCommit(repoRoot)}`);
    }
    violations.push(...ensureCleanTrackedWorkspace(repoRoot));
    if (manifest) {
        violations.push(...validateManifestFileReferences(repoRoot, manifest));
    }
    if (manifest?.untracked_files) {
        for (const entry of manifest.untracked_files) {
            if (fs.existsSync(resolveRepoPath(repoRoot, entry.path))) {
                violations.push(`untracked restore target already exists: ${entry.path}`);
            }
        }
    }
    if (violations.length > 0 || !manifest) {
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            violations,
            output_lines: ['FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED', ...violations.map((violation) => `Violation: ${violation}`)]
        };
    }
    if (params.dryRun) {
        return {
            status: 'DRY_RUN_OK',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            violations: [],
            output_lines: [
                'FULL_SUITE_REPAIR_WIP_RESTORE_DRY_RUN_OK',
                `ManifestPath: ${normalizePath(manifestPath)}`,
                `TrackedFiles: ${manifest.tracked_files.length}`,
                `UntrackedFiles: ${manifest.untracked_files.length}`
            ]
        };
    }

    const restoredFiles = new Set<string>();
    try {
        if (hasPatchContent(manifest.patches.staged)) {
            runGit(repoRoot, ['apply', '--check', '--index', manifest.patches.staged.path]);
            runGit(repoRoot, ['apply', '--index', manifest.patches.staged.path]);
            for (const entry of manifest.tracked_files.filter((file) => file.staged)) {
                restoredFiles.add(entry.path);
            }
        }
        if (hasPatchContent(manifest.patches.unstaged)) {
            runGit(repoRoot, ['apply', '--check', manifest.patches.unstaged.path]);
            runGit(repoRoot, ['apply', manifest.patches.unstaged.path]);
            for (const entry of manifest.tracked_files.filter((file) => file.unstaged)) {
                restoredFiles.add(entry.path);
            }
        }
    } catch (error: unknown) {
        if (hasPatchContent(manifest.patches.staged)) {
            runGit(repoRoot, ['apply', '--reverse', '--index', manifest.patches.staged.path], { allowFailure: true });
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            violations: [`patch restore failed: ${message}`],
            output_lines: ['FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED', `Violation: patch restore failed: ${message}`]
        };
    }
    for (const entry of manifest.untracked_files) {
        const targetPath = resolveRepoPath(repoRoot, entry.path);
        const artifactPath = resolveInputPathInsideRepo(repoRoot, entry.artifact_path, `untracked artifact ${entry.path}`);
        const actualSha256 = sha256FileRequired(artifactPath);
        if (actualSha256 !== entry.sha256) {
            return {
                status: 'BLOCKED',
                manifest_path: normalizePath(manifestPath),
                restored_files: [...restoredFiles].sort(),
                violations: [`untracked artifact ${entry.path} sha256 mismatch: expected=${entry.sha256}; actual=${actualSha256}`],
                output_lines: [
                    'FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED',
                    `Violation: untracked artifact ${entry.path} sha256 mismatch: expected=${entry.sha256}; actual=${actualSha256}`
                ]
            };
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(artifactPath, targetPath);
        restoredFiles.add(entry.path);
    }
    const parentResume = resumeParentTaskAfterWipRestore(repoRoot, manifest.task_id);
    appendMandatoryTaskEvent(
        joinOrchestratorPath(repoRoot, ''),
        manifest.task_id,
        'FULL_SUITE_REPAIR_WIP_RESTORED',
        parentResume.outcome === 'updated' || parentResume.outcome === 'already_synced' ? 'PASS' : 'BLOCKED',
        'Full-suite repair parent WIP restored after repair child completion.',
        {
            manifest_path: normalizePath(manifestPath),
            child_task_id: manifest.child_task_id,
            restored_files: [...restoredFiles].sort(),
            parent_status_sync: parentResume
        },
        { actor: 'orchestrator' }
    );
    if (parentResume.outcome !== 'updated' && parentResume.outcome !== 'already_synced') {
        const violation = `parent status sync failed: ${parentResume.outcome}${parentResume.error_message ? ` (${parentResume.error_message})` : ''}`;
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [...restoredFiles].sort(),
            violations: [violation],
            output_lines: [
                'FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED',
                `ManifestPath: ${normalizePath(manifestPath)}`,
                `RestoredFiles: ${[...restoredFiles].sort().join(', ') || 'none'}`,
                `Violation: ${violation}`
            ]
        };
    }

    return {
        status: 'RESTORED',
        manifest_path: normalizePath(manifestPath),
        restored_files: [...restoredFiles].sort(),
        violations: [],
        output_lines: [
            'FULL_SUITE_REPAIR_WIP_RESTORED',
            `ManifestPath: ${normalizePath(manifestPath)}`,
            `RestoredFiles: ${[...restoredFiles].sort().join(', ') || 'none'}`,
            `ParentStatusSync: ${parentResume.outcome}${parentResume.error_message ? ` (${parentResume.error_message})` : ''}`
        ]
    };
}
