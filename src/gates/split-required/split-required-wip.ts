import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    appendMandatoryTaskEvent
} from '../../gate-runtime/task-events';
import {
    runGit
} from '../../core/git-helpers';
import { isPlainRecord } from '../../core/records';
import {
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    findManifestPaths,
    getHeadCommit,
    normalizeGitPath,
    nowIso,
    readManifest,
    resolveInputPathInsideRepo,
    resolveRepoPath,
    sha256FileRequired,
    writeJson
} from './split-required-wip-contracts';
import type {
    SplitRequiredWipListResult,
    SplitRequiredWipManifest,
    SplitRequiredWipPatchEvidence,
    SplitRequiredWipRestoreResult,
    SplitRequiredWipRetireResult,
    SplitRequiredWipTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence
} from './split-required-wip-contracts';

export { canCaptureSplitRequiredWip } from './split-required-wip-contracts';
export { captureAndSuspendSplitRequiredWip } from './split-required-wip-capture';
export type {
    SplitRequiredWipCaptureResult,
    SplitRequiredWipGuardKind,
    SplitRequiredWipListEntry,
    SplitRequiredWipListResult,
    SplitRequiredWipManifest,
    SplitRequiredWipPatchEvidence,
    SplitRequiredWipRestoreResult,
    SplitRequiredWipRetireResult,
    SplitRequiredWipTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence
} from './split-required-wip-contracts';

interface AdvancedRestorePlan {
    temp_root: string;
    candidate_index_path: string;
    candidate_worktree_root: string;
    current_head: string;
    current_index_sha256: string;
    target_sha256: Map<string, string | null>;
}

function removeFileIfExists(filePath: string): void {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
    }
}

function hasPatchContent(patch: SplitRequiredWipPatchEvidence): boolean {
    return patch.bytes > 0 && !patch.empty;
}

function normalizeSelectedPaths(paths: readonly string[]): Set<string> {
    return new Set(paths.map((entry) => normalizeGitPath(entry)).filter(Boolean));
}

function selectedFiles<T extends { path: string }>(entries: readonly T[], selectedPaths: Set<string>): T[] {
    if (selectedPaths.size === 0) {
        return [...entries];
    }
    return entries.filter((entry) => selectedPaths.has(normalizeGitPath(entry.path)));
}

function buildGitApplyIncludeArgs(selectedPaths: Set<string>): string[] {
    if (selectedPaths.size === 0) {
        return [];
    }
    return [...selectedPaths]
        .sort()
        .map((entry) => `--include=${entry.replace(/([\\*?\[\]])/gu, '\\$1')}`);
}

function indexEntriesByPath(repoRoot: string, indexPath: string): Map<string, string[]> {
    const args = ['ls-files', '--stage', '-z'];
    const result = runGitStatus(repoRoot, args, gitEnvironment(indexPath));
    if (result.status !== 0) {
        throw new Error(gitFailureMessage(args, result));
    }
    const entries = new Map<string, string[]>();
    for (const record of result.stdout.split('\0')) {
        if (!record) {
            continue;
        }
        const separator = record.indexOf('\t');
        if (separator < 0) {
            throw new Error('git ls-files returned malformed index evidence.');
        }
        const filePath = normalizeGitPath(record.slice(separator + 1));
        const pathEntries = entries.get(filePath) || [];
        pathEntries.push(record.slice(0, separator));
        entries.set(filePath, pathEntries);
    }
    return entries;
}

function validateTrackedTargetObstructions(
    repoRoot: string,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): string[] {
    try {
        const currentIndexEntries = indexEntriesByPath(repoRoot, currentIndexPath(repoRoot));
        return selectedTrackedFiles
            .map((entry) => normalizeGitPath(entry.path))
            .filter((relativePath) => fileStateSha256(resolveRepoPath(repoRoot, relativePath)) !== null)
            .filter((relativePath) => !currentIndexEntries.has(relativePath))
            .sort()
            .map((relativePath) => `selected tracked restore target has an untracked obstruction: ${relativePath}`);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`failed to inspect selected restore targets in the current index: ${message}`];
    }
}

function unauthorizedIndexChanges(
    repoRoot: string,
    beforeIndexPath: string,
    afterIndexPath: string,
    selectedPaths: Set<string>
): string[] {
    const before = indexEntriesByPath(repoRoot, beforeIndexPath);
    const after = indexEntriesByPath(repoRoot, afterIndexPath);
    const allPaths = new Set([...before.keys(), ...after.keys()]);
    return [...allPaths]
        .filter((entry) => JSON.stringify(before.get(entry) || []) !== JSON.stringify(after.get(entry) || []))
        .filter((entry) => !selectedPaths.has(entry))
        .sort();
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

function runGitStatus(repoRoot: string, args: string[], environment: NodeJS.ProcessEnv = process.env): {
    status: number;
    stdout: string;
    stderr: string;
} {
    const result = childProcess.spawnSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return {
        status: result.status ?? -1,
        stdout: String(result.stdout || ''),
        stderr: String(result.stderr || '')
    };
}

function gitEnvironment(indexPath: string, worktreePath?: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        GIT_INDEX_FILE: indexPath,
        ...(worktreePath ? { GIT_WORK_TREE: worktreePath } : {})
    };
}

function gitFailureMessage(args: string[], result: { stdout: string; stderr: string }): string {
    return `git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim() || 'unknown git error'}`;
}

function currentIndexPath(repoRoot: string): string {
    const gitPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
    return path.isAbsolute(gitPath) ? path.resolve(gitPath) : path.resolve(repoRoot, gitPath);
}

function fileStateSha256(filePath: string): string | null {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(filePath);
    } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
            return null;
        }
        throw error;
    }
    if (!stat.isFile()) {
        return `non-file:${stat.mode}`;
    }
    return sha256FileRequired(filePath);
}

function selectedTargetState(repoRoot: string, selectedPaths: Set<string>): Map<string, string | null> {
    return new Map([...selectedPaths].map((relativePath) => [
        relativePath,
        fileStateSha256(resolveRepoPath(repoRoot, relativePath))
    ]));
}

function validateSelectedTargetsClean(repoRoot: string, selectedPaths: Set<string>): string[] {
    const violations: string[] = [];
    for (const relativePath of [...selectedPaths].sort()) {
        for (const args of [
            ['diff', '--quiet', '--', relativePath],
            ['diff', '--cached', '--quiet', '--', relativePath]
        ]) {
            const result = runGitStatus(repoRoot, args);
            if (result.status === 1) {
                violations.push(`selected restore target is dirty: ${relativePath}`);
                break;
            }
            if (result.status !== 0) {
                violations.push(gitFailureMessage(args, result));
                break;
            }
        }
    }
    return violations;
}

function validateNoSymlinkPath(repoRoot: string, relativePath: string): string[] {
    const violations: string[] = [];
    const root = path.resolve(repoRoot);
    const target = resolveRepoPath(root, relativePath);
    let cursor = target;
    while (cursor !== root) {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
            violations.push(`selected restore path contains a symbolic link: ${relativePath}`);
            break;
        }
        cursor = path.dirname(cursor);
    }
    const tree = runGitStatus(repoRoot, ['ls-tree', '-z', 'HEAD', '--', normalizeGitPath(relativePath)]);
    if (tree.status !== 0) {
        violations.push(gitFailureMessage(['ls-tree', 'HEAD', '--', relativePath], tree));
    } else if (tree.stdout.startsWith('120000 ')) {
        violations.push(`selected restore target is a symbolic link in HEAD: ${relativePath}`);
    }
    return violations;
}

function validateAdvancedManifestBlobs(
    repoRoot: string,
    manifest: SplitRequiredWipManifest,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): string[] {
    const violations: string[] = [];
    const commitCheck = runGitStatus(repoRoot, ['cat-file', '-e', `${manifest.base_commit}^{commit}`]);
    if (commitCheck.status !== 0) {
        return [`manifest base commit is missing or invalid: ${manifest.base_commit}`];
    }
    for (const entry of selectedTrackedFiles) {
        if (!entry.head_sha256) {
            const absent = runGitStatus(repoRoot, ['cat-file', '-e', `${manifest.base_commit}:${entry.path}`]);
            if (absent.status === 0) {
                violations.push(`manifest base blob evidence is missing for tracked path: ${entry.path}`);
            }
            continue;
        }
        const blobCheck = runGitStatus(repoRoot, ['cat-file', '-e', `${entry.head_sha256}^{blob}`]);
        if (blobCheck.status !== 0) {
            violations.push(`manifest base blob is missing: path=${entry.path}; blob=${entry.head_sha256}`);
            continue;
        }
        const baseBlob = runGitStatus(repoRoot, ['rev-parse', `${manifest.base_commit}:${entry.path}`]);
        if (baseBlob.status !== 0 || baseBlob.stdout.trim() !== entry.head_sha256) {
            violations.push(`manifest base blob does not match base commit: path=${entry.path}; blob=${entry.head_sha256}`);
        }
    }
    return violations;
}

function planAdvancedRestore(
    repoRoot: string,
    manifest: SplitRequiredWipManifest,
    selectedPaths: Set<string>,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): { plan: AdvancedRestorePlan | null; violations: string[] } {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-wip-restore-'));
    const candidateIndexPath = path.join(tempRoot, 'candidate.index');
    const unstagedIndexPath = path.join(tempRoot, 'unstaged.index');
    const candidateWorktreeRoot = path.join(tempRoot, 'worktree');
    const indexPath = currentIndexPath(repoRoot);
    const includeArgs = buildGitApplyIncludeArgs(selectedPaths);
    const fail = (message: string): { plan: null; violations: string[] } => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        return { plan: null, violations: [`three-way restore failed: ${message}`] };
    };
    try {
        fs.mkdirSync(candidateWorktreeRoot, { recursive: true });
        fs.copyFileSync(indexPath, candidateIndexPath);
        const candidateEnvironment = gitEnvironment(candidateIndexPath);
        if (hasPatchContent(manifest.patches.staged)) {
            const args = ['apply', '--3way', '--cached', ...includeArgs, manifest.patches.staged.path];
            const applied = runGitStatus(repoRoot, args, candidateEnvironment);
            if (applied.status !== 0) {
                return fail(gitFailureMessage(args, applied));
            }
            const unauthorized = unauthorizedIndexChanges(repoRoot, indexPath, candidateIndexPath, selectedPaths);
            if (unauthorized.length > 0) {
                return fail(`staged patch changed unauthorized paths: ${unauthorized.join(', ')}`);
            }
        }
        fs.copyFileSync(candidateIndexPath, unstagedIndexPath);
        if (hasPatchContent(manifest.patches.unstaged)) {
            const args = ['apply', '--3way', '--cached', ...includeArgs, manifest.patches.unstaged.path];
            const applied = runGitStatus(repoRoot, args, gitEnvironment(unstagedIndexPath));
            if (applied.status !== 0) {
                return fail(gitFailureMessage(args, applied));
            }
            const unauthorized = unauthorizedIndexChanges(repoRoot, candidateIndexPath, unstagedIndexPath, selectedPaths);
            if (unauthorized.length > 0) {
                return fail(`unstaged patch changed unauthorized paths: ${unauthorized.join(', ')}`);
            }
        }
        const unstagedEnvironment = gitEnvironment(unstagedIndexPath);
        for (const entry of selectedTrackedFiles) {
            const args = ['checkout-index', '--force', `--prefix=${normalizePath(candidateWorktreeRoot)}/`, '--', entry.path];
            const checkedOut = runGitStatus(repoRoot, args, unstagedEnvironment);
            if (checkedOut.status !== 0 && !checkedOut.stderr.includes('is not in the cache')) {
                return fail(gitFailureMessage(args, checkedOut));
            }
        }
        for (const entry of selectedTrackedFiles) {
            const candidatePath = resolveRepoPath(candidateWorktreeRoot, entry.path);
            if (fs.existsSync(candidatePath) && fs.lstatSync(candidatePath).isSymbolicLink()) {
                return fail(`candidate restore target is a symbolic link: ${entry.path}`);
            }
            const stage = runGitStatus(repoRoot, ['ls-files', '--stage', '--', entry.path], gitEnvironment(candidateIndexPath));
            if (stage.status !== 0) {
                return fail(gitFailureMessage(['ls-files', '--stage', '--', entry.path], stage));
            }
            if (stage.stdout.startsWith('120000 ')) {
                return fail(`candidate index target is a symbolic link: ${entry.path}`);
            }
        }
        return {
            plan: {
                temp_root: tempRoot,
                candidate_index_path: candidateIndexPath,
                candidate_worktree_root: candidateWorktreeRoot,
                current_head: getHeadCommit(repoRoot),
                current_index_sha256: sha256FileRequired(indexPath),
                target_sha256: selectedTargetState(repoRoot, selectedPaths)
            },
            violations: []
        };
    } catch (error: unknown) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}

function replaceFileFromCandidate(candidatePath: string, targetPath: string, token: string): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const stagedPath = `${targetPath}.garda-${token}.tmp`;
    fs.copyFileSync(candidatePath, stagedPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(stagedPath, fs.statSync(candidatePath).mode);
    fs.renameSync(stagedPath, targetPath);
}

function applyAdvancedRestorePlan(
    repoRoot: string,
    plan: AdvancedRestorePlan,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[],
    selectedUntrackedFiles: SplitRequiredWipUntrackedFileEvidence[]
): string[] {
    const indexPath = currentIndexPath(repoRoot);
    const selectedPaths = new Set([
        ...selectedTrackedFiles.map((entry) => normalizeGitPath(entry.path)),
        ...selectedUntrackedFiles.map((entry) => normalizeGitPath(entry.path))
    ]);
    if (getHeadCommit(repoRoot) !== plan.current_head
        || sha256FileRequired(indexPath) !== plan.current_index_sha256) {
        return ['three-way restore failed: repository HEAD or index changed after validation.'];
    }
    const currentTargets = selectedTargetState(repoRoot, selectedPaths);
    for (const [relativePath, expected] of plan.target_sha256) {
        if (currentTargets.get(relativePath) !== expected) {
            return [`three-way restore failed: selected target changed after validation: ${relativePath}`];
        }
    }
    const backupRoot = path.join(plan.temp_root, 'backup');
    const backupIndexPath = path.join(backupRoot, 'index');
    const token = path.basename(plan.temp_root);
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.copyFileSync(indexPath, backupIndexPath);
    const originalFiles = new Map<string, { exists: boolean; backup_path: string; mode: number | null }>();
    for (const relativePath of selectedPaths) {
        const targetPath = resolveRepoPath(repoRoot, relativePath);
        const backupPath = resolveRepoPath(backupRoot, relativePath);
        const exists = fs.existsSync(targetPath);
        if (exists) {
            fs.mkdirSync(path.dirname(backupPath), { recursive: true });
            fs.copyFileSync(targetPath, backupPath);
        }
        originalFiles.set(relativePath, {
            exists,
            backup_path: backupPath,
            mode: exists ? fs.statSync(targetPath).mode : null
        });
    }
    const restoreOriginalState = (): void => {
        fs.copyFileSync(backupIndexPath, indexPath);
        for (const [relativePath, original] of originalFiles) {
            const targetPath = resolveRepoPath(repoRoot, relativePath);
            if (!original.exists) {
                removeFileIfExists(targetPath);
                continue;
            }
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.copyFileSync(original.backup_path, targetPath);
            if (original.mode !== null) {
                fs.chmodSync(targetPath, original.mode);
            }
        }
    };
    try {
        for (const entry of selectedTrackedFiles) {
            const candidatePath = resolveRepoPath(plan.candidate_worktree_root, entry.path);
            const targetPath = resolveRepoPath(repoRoot, entry.path);
            if (fs.existsSync(candidatePath)) {
                replaceFileFromCandidate(candidatePath, targetPath, token);
            } else {
                removeFileIfExists(targetPath);
            }
        }
        for (const entry of selectedUntrackedFiles) {
            replaceFileFromCandidate(
                resolveInputPathInsideRepo(repoRoot, entry.artifact_path, `untracked artifact ${entry.path}`),
                resolveRepoPath(repoRoot, entry.path),
                token
            );
        }
        const indexLockPath = `${indexPath}.lock`;
        fs.copyFileSync(plan.candidate_index_path, indexLockPath, fs.constants.COPYFILE_EXCL);
        fs.renameSync(indexLockPath, indexPath);
        return [];
    } catch (error: unknown) {
        try {
            restoreOriginalState();
        } catch (rollbackError: unknown) {
            const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            return [`three-way restore failed and rollback failed: ${message}`];
        }
        const message = error instanceof Error ? error.message : String(error);
        return [`three-way restore failed without retained mutations: ${message}`];
    }
}

function validateManifestFileReferences(repoRoot: string, manifest: SplitRequiredWipManifest): string[] {
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
        if (fs.lstatSync(artifactPath).isSymbolicLink()) {
            violations.push(`${label} artifact must not be a symbolic link: ${normalizePath(artifactPath)}`);
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

export function listSplitRequiredWip(params: {
    repoRoot: string;
    taskId: string;
}): SplitRequiredWipListResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    const taskId = String(params.taskId || '').trim();
    const manifests = findManifestPaths(repoRoot, taskId)
        .map((manifestPath) => ({ manifestPath, manifest: readManifest(manifestPath) }))
        .filter((entry): entry is { manifestPath: string; manifest: SplitRequiredWipManifest } => Boolean(entry.manifest))
        .map((entry) => ({
            manifest_path: normalizePath(entry.manifestPath),
            manifest_sha256: sha256FileRequired(entry.manifestPath),
            task_id: entry.manifest.task_id,
            guard_kind: entry.manifest.guard_kind,
            status: entry.manifest.status,
            base_commit: entry.manifest.base_commit,
            tracked_files: entry.manifest.tracked_files.map((file) => file.path).sort(),
            untracked_files: entry.manifest.untracked_files.map((file) => file.path).sort(),
            created_at_utc: entry.manifest.created_at_utc
        }));
    return {
        status: manifests.length > 0 ? 'FOUND' : 'EMPTY',
        task_id: taskId,
        manifests,
        output_lines: [
            manifests.length > 0 ? 'SPLIT_REQUIRED_WIP_FOUND' : 'SPLIT_REQUIRED_WIP_EMPTY',
            `TaskId: ${taskId}`,
            `ManifestCount: ${manifests.length}`,
            ...manifests.flatMap((entry) => [
                `ManifestPath: ${entry.manifest_path}`,
                `Status: ${entry.status}`,
                `GuardKind: ${entry.guard_kind}`,
                `TrackedFiles: ${entry.tracked_files.join(', ') || 'none'}`,
                `UntrackedFiles: ${entry.untracked_files.join(', ') || 'none'}`
            ])
        ]
    };
}

export function restoreSplitRequiredWip(params: {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    includePaths?: readonly string[];
    dryRun?: boolean;
}): SplitRequiredWipRestoreResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    let manifestPath = '';
    try {
        manifestPath = resolveInputPathInsideRepo(repoRoot, params.manifestPath, 'ManifestPath');
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(path.resolve(repoRoot, String(params.manifestPath || ''))),
            restored_files: [],
            selected_paths: [],
            violations: [message],
            output_lines: ['SPLIT_REQUIRED_WIP_RESTORE_BLOCKED', `Violation: ${message}`]
        };
    }
    const selectedPaths = normalizeSelectedPaths(params.includePaths || []);
    const manifest = readManifest(manifestPath);
    const violations: string[] = [];
    let advancedHead = false;
    let advancedPlan: AdvancedRestorePlan | null = null;
    let selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[] = [];
    let selectedUntrackedFiles: SplitRequiredWipUntrackedFileEvidence[] = [];
    if (!manifest) {
        violations.push('WIP manifest is missing or invalid.');
    } else {
        if (manifest.task_id !== String(params.taskId || '').trim()) {
            violations.push(`WIP manifest task_id mismatch: expected=${params.taskId}; actual=${manifest.task_id}.`);
        }
        if (manifest.status !== 'suspended') {
            violations.push(`WIP manifest status must be suspended; found ${manifest.status}.`);
        }
        const currentHead = getHeadCommit(repoRoot);
        advancedHead = Boolean(manifest.base_commit && currentHead !== manifest.base_commit);
        const restorablePaths = new Set([
            ...manifest.tracked_files.map((entry) => normalizeGitPath(entry.path)),
            ...manifest.untracked_files.map((entry) => normalizeGitPath(entry.path))
        ]);
        for (const selectedPath of selectedPaths) {
            if (!restorablePaths.has(selectedPath)) {
                violations.push(`selected path is not present in WIP manifest: ${selectedPath}`);
            }
        }
        selectedTrackedFiles = selectedFiles(manifest.tracked_files, selectedPaths);
        selectedUntrackedFiles = selectedFiles(manifest.untracked_files, selectedPaths);
        if (advancedHead) {
            if (selectedPaths.size === 0) {
                violations.push('advanced restore requires at least one explicit include-path authorization.');
            }
            const ancestry = runGitStatus(repoRoot, ['merge-base', '--is-ancestor', manifest.base_commit, currentHead]);
            if (ancestry.status === 1) {
                violations.push(`manifest base commit is not an ancestor of current HEAD: manifest=${manifest.base_commit}; current=${currentHead}`);
            } else if (ancestry.status !== 0) {
                violations.push(gitFailureMessage(['merge-base', '--is-ancestor', manifest.base_commit, currentHead], ancestry));
            }
            violations.push(...validateSelectedTargetsClean(repoRoot, selectedPaths));
            violations.push(...validateTrackedTargetObstructions(repoRoot, selectedTrackedFiles));
            for (const selectedPath of selectedPaths) {
                violations.push(...validateNoSymlinkPath(repoRoot, selectedPath));
            }
            violations.push(...validateAdvancedManifestBlobs(repoRoot, manifest, selectedTrackedFiles));
        } else {
            violations.push(...ensureCleanTrackedWorkspace(repoRoot));
        }
        violations.push(...validateManifestFileReferences(repoRoot, manifest));
        for (const entry of selectedUntrackedFiles) {
            if (fs.existsSync(resolveRepoPath(repoRoot, entry.path))) {
                violations.push(`untracked restore target already exists: ${entry.path}`);
            }
        }
        if (advancedHead && violations.length === 0) {
            const planned = planAdvancedRestore(repoRoot, manifest, selectedPaths, selectedTrackedFiles);
            advancedPlan = planned.plan;
            violations.push(...planned.violations);
        }
    }
    if (violations.length > 0 || !manifest) {
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            selected_paths: [...selectedPaths].sort(),
            violations,
            output_lines: ['SPLIT_REQUIRED_WIP_RESTORE_BLOCKED', ...violations.map((violation) => `Violation: ${violation}`)]
        };
    }
    if (params.dryRun) {
        if (advancedPlan) {
            fs.rmSync(advancedPlan.temp_root, { recursive: true, force: true });
        }
        return {
            status: 'DRY_RUN_OK',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            selected_paths: [...selectedPaths].sort(),
            violations: [],
            output_lines: [
                'SPLIT_REQUIRED_WIP_RESTORE_DRY_RUN_OK',
                `ManifestPath: ${normalizePath(manifestPath)}`,
                `SelectedPaths: ${[...selectedPaths].sort().join(', ') || 'all'}`,
                `TrackedFiles: ${selectedTrackedFiles.map((entry) => entry.path).join(', ') || 'none'}`,
                `UntrackedFiles: ${selectedUntrackedFiles.map((entry) => entry.path).join(', ') || 'none'}`
            ]
        };
    }

    const restoredFiles = new Set<string>();
    if (advancedHead && advancedPlan) {
        const advancedViolations = applyAdvancedRestorePlan(
            repoRoot,
            advancedPlan,
            selectedTrackedFiles,
            selectedUntrackedFiles
        );
        fs.rmSync(advancedPlan.temp_root, { recursive: true, force: true });
        if (advancedViolations.length > 0) {
            return {
                status: 'BLOCKED',
                manifest_path: normalizePath(manifestPath),
                restored_files: [],
                selected_paths: [...selectedPaths].sort(),
                violations: advancedViolations,
                output_lines: ['SPLIT_REQUIRED_WIP_RESTORE_BLOCKED', ...advancedViolations.map((violation) => `Violation: ${violation}`)]
            };
        }
        for (const entry of [...selectedTrackedFiles, ...selectedUntrackedFiles]) {
            restoredFiles.add(entry.path);
        }
    }
    const includeArgs = buildGitApplyIncludeArgs(selectedPaths);
    try {
        if (advancedHead) {
            // Advanced restore was applied transactionally from the validated temporary plan above.
        } else if (hasPatchContent(manifest.patches.staged)) {
            runGit(repoRoot, ['apply', ...includeArgs, '--check', '--index', manifest.patches.staged.path]);
            runGit(repoRoot, ['apply', ...includeArgs, '--index', manifest.patches.staged.path]);
            for (const entry of selectedTrackedFiles.filter((file) => file.staged)) {
                restoredFiles.add(entry.path);
            }
        }
        if (!advancedHead && hasPatchContent(manifest.patches.unstaged)) {
            runGit(repoRoot, ['apply', ...includeArgs, '--check', manifest.patches.unstaged.path]);
            runGit(repoRoot, ['apply', ...includeArgs, manifest.patches.unstaged.path]);
            for (const entry of selectedTrackedFiles.filter((file) => file.unstaged)) {
                restoredFiles.add(entry.path);
            }
        }
    } catch (error: unknown) {
        if (!advancedHead && hasPatchContent(manifest.patches.staged)) {
            runGit(repoRoot, ['apply', '--reverse', '--index', manifest.patches.staged.path], { allowFailure: true });
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            selected_paths: [...selectedPaths].sort(),
            violations: [`patch restore failed: ${message}`],
            output_lines: ['SPLIT_REQUIRED_WIP_RESTORE_BLOCKED', `Violation: patch restore failed: ${message}`]
        };
    }
    for (const entry of advancedHead ? [] : selectedUntrackedFiles) {
        const targetPath = resolveRepoPath(repoRoot, entry.path);
        const artifactPath = resolveInputPathInsideRepo(repoRoot, entry.artifact_path, `untracked artifact ${entry.path}`);
        const actualSha256 = sha256FileRequired(artifactPath);
        if (actualSha256 !== entry.sha256) {
            return {
                status: 'BLOCKED',
                manifest_path: normalizePath(manifestPath),
                restored_files: [...restoredFiles].sort(),
                selected_paths: [...selectedPaths].sort(),
                violations: [`untracked artifact ${entry.path} sha256 mismatch: expected=${entry.sha256}; actual=${actualSha256}`],
                output_lines: [
                    'SPLIT_REQUIRED_WIP_RESTORE_BLOCKED',
                    `Violation: untracked artifact ${entry.path} sha256 mismatch: expected=${entry.sha256}; actual=${actualSha256}`
                ]
            };
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(artifactPath, targetPath);
        restoredFiles.add(entry.path);
    }
    appendMandatoryTaskEvent(
        joinOrchestratorPath(repoRoot, ''),
        manifest.task_id,
        'SPLIT_REQUIRED_WIP_RESTORED',
        'PASS',
        'Split-required WIP restored by explicit command.',
        {
            manifest_path: normalizePath(manifestPath),
            restored_files: [...restoredFiles].sort(),
            selected_paths: [...selectedPaths].sort()
        },
        { actor: 'orchestrator' }
    );

    return {
        status: 'RESTORED',
        manifest_path: normalizePath(manifestPath),
        restored_files: [...restoredFiles].sort(),
        selected_paths: [...selectedPaths].sort(),
        violations: [],
        output_lines: [
            'SPLIT_REQUIRED_WIP_RESTORED',
            `ManifestPath: ${normalizePath(manifestPath)}`,
            `SelectedPaths: ${[...selectedPaths].sort().join(', ') || 'all'}`,
            `RestoredFiles: ${[...restoredFiles].sort().join(', ') || 'none'}`
        ]
    };
}

export function retireSplitRequiredWip(params: {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    reason: string;
}): SplitRequiredWipRetireResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    let manifestPath = '';
    try {
        manifestPath = resolveInputPathInsideRepo(repoRoot, params.manifestPath, 'ManifestPath');
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(path.resolve(repoRoot, String(params.manifestPath || ''))),
            violations: [message],
            output_lines: ['SPLIT_REQUIRED_WIP_RETIRE_BLOCKED', `Violation: ${message}`]
        };
    }
    const reason = String(params.reason || '').trim();
    const manifest = readManifest(manifestPath);
    const violations: string[] = [];
    if (!manifest) {
        violations.push('WIP manifest is missing or invalid.');
    } else if (manifest.task_id !== String(params.taskId || '').trim()) {
        violations.push(`WIP manifest task_id mismatch: expected=${params.taskId}; actual=${manifest.task_id}.`);
    }
    if (!reason) {
        violations.push('Reason is required.');
    }
    if (violations.length > 0 || !manifest) {
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            violations,
            output_lines: ['SPLIT_REQUIRED_WIP_RETIRE_BLOCKED', ...violations.map((violation) => `Violation: ${violation}`)]
        };
    }
    if (manifest.status === 'retired') {
        return {
            status: 'ALREADY_RETIRED',
            manifest_path: normalizePath(manifestPath),
            violations: [],
            output_lines: ['SPLIT_REQUIRED_WIP_ALREADY_RETIRED', `ManifestPath: ${normalizePath(manifestPath)}`]
        };
    }
    const updated: SplitRequiredWipManifest = {
        ...manifest,
        status: 'retired',
        retired_at_utc: nowIso(),
        retired_reason: reason
    };
    writeJson(manifestPath, updated);
    appendMandatoryTaskEvent(
        joinOrchestratorPath(repoRoot, ''),
        manifest.task_id,
        'SPLIT_REQUIRED_WIP_RETIRED',
        'INFO',
        'Split-required WIP manifest retired by explicit command.',
        {
            manifest_path: normalizePath(manifestPath),
            manifest_sha256: sha256FileRequired(manifestPath),
            reason
        },
        { actor: 'orchestrator' }
    );
    return {
        status: 'RETIRED',
        manifest_path: normalizePath(manifestPath),
        violations: [],
        output_lines: [
            'SPLIT_REQUIRED_WIP_RETIRED',
            `ManifestPath: ${normalizePath(manifestPath)}`,
            `Reason: ${reason}`
        ]
    };
}
