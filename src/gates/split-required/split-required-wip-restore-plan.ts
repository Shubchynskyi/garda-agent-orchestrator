import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runGit } from '../../core/git-helpers';
import { isPlainRecord } from '../../core/records';
import { normalizePath } from '../shared/helpers';
import {
    getHeadCommit,
    normalizeGitPath,
    resolveInputPathInsideRepo,
    resolveRepoPath,
    sha256FileRequired
} from './split-required-wip-contracts';
import type {
    SplitRequiredWipManifest,
    SplitRequiredWipPatchEvidence,
    SplitRequiredWipTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence
} from './split-required-wip-contracts';

export interface AdvancedRestorePlan {
    tempRoot: string;
    candidateIndexPath: string;
    candidateWorktreeRoot: string;
    currentHead: string;
    currentIndexSha256: string;
    targetSha256: Map<string, string | null>;
}

function removeFileIfExists(filePath: string): void {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
    }
}

export function hasPatchContent(patch: SplitRequiredWipPatchEvidence): boolean {
    return patch.bytes > 0 && !patch.empty;
}

export function normalizeSelectedPaths(paths: readonly string[]): Set<string> {
    return new Set(paths.map((entry) => normalizeGitPath(entry)).filter(Boolean));
}

export function selectedFiles<T extends { path: string }>(
    entries: readonly T[],
    selectedPaths: Set<string>
): T[] {
    if (selectedPaths.size === 0) {
        return [...entries];
    }
    return entries.filter((entry) => selectedPaths.has(normalizeGitPath(entry.path)));
}

export function buildGitApplyIncludeArgs(selectedPaths: Set<string>): string[] {
    if (selectedPaths.size === 0) {
        return [];
    }
    return [...selectedPaths]
        .sort()
        .map((entry) => `--include=${entry.replace(/([\\*?\[\]])/gu, '\\$1')}`);
}

export function runGitStatus(
    repoRoot: string,
    args: string[],
    environment: NodeJS.ProcessEnv = process.env
): {
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

export function gitFailureMessage(
    args: string[],
    result: { stdout: string; stderr: string }
): string {
    return `git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim() || 'unknown git error'}`;
}

function currentIndexPath(repoRoot: string): string {
    const gitPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
    return path.isAbsolute(gitPath) ? path.resolve(gitPath) : path.resolve(repoRoot, gitPath);
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

export function validateTrackedTargetObstructions(
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

export function ensureCleanTrackedWorkspace(repoRoot: string): string[] {
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

export function validateSelectedTargetsClean(repoRoot: string, selectedPaths: Set<string>): string[] {
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

export function validateNoSymlinkPath(repoRoot: string, relativePath: string): string[] {
    const violations: string[] = [];
    const root = path.resolve(repoRoot);
    const target = resolveRepoPath(root, relativePath);
    let cursor = target;
    while (cursor !== root) {
        try {
            if (fs.lstatSync(cursor).isSymbolicLink()) {
                violations.push(`selected restore path contains a symbolic link: ${relativePath}`);
                break;
            }
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
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

export function validateAdvancedManifestBlobs(
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

interface RestorePlanWorkspace {
    tempRoot: string;
    indexPath: string;
    candidateIndexPath: string;
    unstagedIndexPath: string;
    candidateWorktreeRoot: string;
}

function createRestorePlanWorkspace(repoRoot: string): RestorePlanWorkspace {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-wip-restore-'));
    return {
        tempRoot,
        indexPath: currentIndexPath(repoRoot),
        candidateIndexPath: path.join(tempRoot, 'candidate.index'),
        unstagedIndexPath: path.join(tempRoot, 'unstaged.index'),
        candidateWorktreeRoot: path.join(tempRoot, 'worktree')
    };
}

function applyPatchToCandidateIndex(params: {
    repoRoot: string;
    patch: SplitRequiredWipPatchEvidence;
    label: 'staged' | 'unstaged';
    beforeIndexPath: string;
    targetIndexPath: string;
    includeArgs: string[];
    selectedPaths: Set<string>;
}): string | null {
    if (!hasPatchContent(params.patch)) {
        return null;
    }
    const args = ['apply', '--3way', '--cached', ...params.includeArgs, params.patch.path];
    const applied = runGitStatus(params.repoRoot, args, gitEnvironment(params.targetIndexPath));
    if (applied.status !== 0) {
        return gitFailureMessage(args, applied);
    }
    const unauthorized = unauthorizedIndexChanges(
        params.repoRoot,
        params.beforeIndexPath,
        params.targetIndexPath,
        params.selectedPaths
    );
    return unauthorized.length > 0
        ? `${params.label} patch changed unauthorized paths: ${unauthorized.join(', ')}`
        : null;
}

function buildCandidateIndexes(
    repoRoot: string,
    workspace: RestorePlanWorkspace,
    manifest: SplitRequiredWipManifest,
    selectedPaths: Set<string>
): string | null {
    const includeArgs = buildGitApplyIncludeArgs(selectedPaths);
    fs.copyFileSync(workspace.indexPath, workspace.candidateIndexPath);
    const stagedFailure = applyPatchToCandidateIndex({
        repoRoot,
        patch: manifest.patches.staged,
        label: 'staged',
        beforeIndexPath: workspace.indexPath,
        targetIndexPath: workspace.candidateIndexPath,
        includeArgs,
        selectedPaths
    });
    if (stagedFailure) {
        return stagedFailure;
    }
    fs.copyFileSync(workspace.candidateIndexPath, workspace.unstagedIndexPath);
    return applyPatchToCandidateIndex({
        repoRoot,
        patch: manifest.patches.unstaged,
        label: 'unstaged',
        beforeIndexPath: workspace.candidateIndexPath,
        targetIndexPath: workspace.unstagedIndexPath,
        includeArgs,
        selectedPaths
    });
}

function materializeCandidateWorktree(
    repoRoot: string,
    workspace: RestorePlanWorkspace,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): string | null {
    const environment = gitEnvironment(workspace.unstagedIndexPath);
    for (const entry of selectedTrackedFiles) {
        const args = [
            'checkout-index',
            '--force',
            `--prefix=${normalizePath(workspace.candidateWorktreeRoot)}/`,
            '--',
            entry.path
        ];
        const checkedOut = runGitStatus(repoRoot, args, environment);
        if (checkedOut.status !== 0 && !checkedOut.stderr.includes('is not in the cache')) {
            return gitFailureMessage(args, checkedOut);
        }
    }
    return null;
}

function validateCandidateTrackedFiles(
    repoRoot: string,
    workspace: RestorePlanWorkspace,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): string | null {
    const environment = gitEnvironment(workspace.unstagedIndexPath);
    for (const entry of selectedTrackedFiles) {
        const candidatePath = resolveRepoPath(workspace.candidateWorktreeRoot, entry.path);
        try {
            if (fs.lstatSync(candidatePath).isSymbolicLink()) {
                return `candidate restore target is a symbolic link: ${entry.path}`;
            }
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        const args = ['ls-files', '--stage', '--', entry.path];
        const stage = runGitStatus(repoRoot, args, environment);
        if (stage.status !== 0) {
            return gitFailureMessage(args, stage);
        }
        if (stage.stdout.startsWith('120000 ')) {
            return `candidate index target is a symbolic link: ${entry.path}`;
        }
    }
    return null;
}

export function planAdvancedRestore(
    repoRoot: string,
    manifest: SplitRequiredWipManifest,
    selectedPaths: Set<string>,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): { plan: AdvancedRestorePlan | null; violations: string[] } {
    const workspace = createRestorePlanWorkspace(repoRoot);
    const fail = (message: string): { plan: null; violations: string[] } => {
        fs.rmSync(workspace.tempRoot, { recursive: true, force: true });
        return { plan: null, violations: [`three-way restore failed: ${message}`] };
    };
    try {
        fs.mkdirSync(workspace.candidateWorktreeRoot, { recursive: true });
        const failure = buildCandidateIndexes(repoRoot, workspace, manifest, selectedPaths)
            || materializeCandidateWorktree(repoRoot, workspace, selectedTrackedFiles)
            || validateCandidateTrackedFiles(repoRoot, workspace, selectedTrackedFiles);
        if (failure) {
            return fail(failure);
        }
        return {
            plan: {
                tempRoot: workspace.tempRoot,
                candidateIndexPath: workspace.candidateIndexPath,
                candidateWorktreeRoot: workspace.candidateWorktreeRoot,
                currentHead: getHeadCommit(repoRoot),
                currentIndexSha256: sha256FileRequired(workspace.indexPath),
                targetSha256: selectedTargetState(repoRoot, selectedPaths)
            },
            violations: []
        };
    } catch (error: unknown) {
        return fail(error instanceof Error ? error.message : String(error));
    }
}

function replaceFileFromCandidate(
    candidatePath: string,
    targetPath: string,
    token: string,
    transientPaths: Set<string>,
    integrity?: {
        label: string;
        expectedSha256: string;
    }
): void {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const stagedPath = `${targetPath}.garda-${token}.tmp`;
    transientPaths.add(stagedPath);
    fs.copyFileSync(candidatePath, stagedPath, fs.constants.COPYFILE_EXCL);
    if (integrity) {
        const violation = validateArtifactHash(
            integrity.label,
            stagedPath,
            integrity.expectedSha256
        );
        if (violation) {
            throw new Error(violation);
        }
    }
    fs.chmodSync(stagedPath, fs.statSync(candidatePath).mode);
    fs.renameSync(stagedPath, targetPath);
    transientPaths.delete(stagedPath);
}

interface OriginalFileState {
    exists: boolean;
    backupPath: string;
    mode: number | null;
}

interface RestoreBackup {
    backupIndexPath: string;
    originalFiles: Map<string, OriginalFileState>;
    transientPaths: Set<string>;
    token: string;
}

function selectedRestorePaths(
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[],
    selectedUntrackedFiles: SplitRequiredWipUntrackedFileEvidence[]
): Set<string> {
    return new Set([
        ...selectedTrackedFiles.map((entry) => normalizeGitPath(entry.path)),
        ...selectedUntrackedFiles.map((entry) => normalizeGitPath(entry.path))
    ]);
}

function validateRestorePlanFreshness(
    repoRoot: string,
    indexPath: string,
    plan: AdvancedRestorePlan,
    selectedPaths: Set<string>
): string | null {
    if (getHeadCommit(repoRoot) !== plan.currentHead
        || sha256FileRequired(indexPath) !== plan.currentIndexSha256) {
        return 'three-way restore failed: repository HEAD or index changed after validation.';
    }
    const currentTargets = selectedTargetState(repoRoot, selectedPaths);
    for (const [relativePath, expected] of plan.targetSha256) {
        if (currentTargets.get(relativePath) !== expected) {
            return `three-way restore failed: selected target changed after validation: ${relativePath}`;
        }
    }
    return null;
}

function captureRestoreBackup(
    repoRoot: string,
    indexPath: string,
    plan: AdvancedRestorePlan,
    selectedPaths: Set<string>
): RestoreBackup {
    const backupRoot = path.join(plan.tempRoot, 'backup');
    const backupIndexPath = path.join(backupRoot, 'index');
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.copyFileSync(indexPath, backupIndexPath);
    const originalFiles = new Map<string, OriginalFileState>();
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
            backupPath,
            mode: exists ? fs.statSync(targetPath).mode : null
        });
    }
    return {
        backupIndexPath,
        originalFiles,
        transientPaths: new Set<string>(),
        token: path.basename(plan.tempRoot)
    };
}

function restoreFromBackup(
    repoRoot: string,
    indexPath: string,
    backup: RestoreBackup
): void {
    fs.copyFileSync(backup.backupIndexPath, indexPath);
    for (const [relativePath, original] of backup.originalFiles) {
        const targetPath = resolveRepoPath(repoRoot, relativePath);
        if (!original.exists) {
            removeFileIfExists(targetPath);
            continue;
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(original.backupPath, targetPath);
        if (original.mode !== null) {
            fs.chmodSync(targetPath, original.mode);
        }
    }
    for (const transientPath of backup.transientPaths) {
        removeFileIfExists(transientPath);
    }
    backup.transientPaths.clear();
}

function applyCandidateFiles(
    repoRoot: string,
    plan: AdvancedRestorePlan,
    backup: RestoreBackup,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[],
    selectedUntrackedFiles: SplitRequiredWipUntrackedFileEvidence[]
): void {
    for (const entry of selectedTrackedFiles) {
        const candidatePath = resolveRepoPath(plan.candidateWorktreeRoot, entry.path);
        const targetPath = resolveRepoPath(repoRoot, entry.path);
        let candidateExists = true;
        try {
            if (fs.lstatSync(candidatePath).isSymbolicLink()) {
                throw new Error(`candidate restore target is a symbolic link: ${entry.path}`);
            }
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                candidateExists = false;
            } else {
                throw error;
            }
        }
        if (candidateExists) {
            replaceFileFromCandidate(candidatePath, targetPath, backup.token, backup.transientPaths);
        } else {
            removeFileIfExists(targetPath);
        }
    }
    for (const entry of selectedUntrackedFiles) {
        const label = `untracked artifact ${entry.path}`;
        const artifactPath = resolveInputPathInsideRepo(repoRoot, entry.artifact_path, label);
        const violation = validateArtifactHash(label, artifactPath, entry.sha256);
        if (violation) {
            throw new Error(violation);
        }
        replaceFileFromCandidate(
            artifactPath,
            resolveRepoPath(repoRoot, entry.path),
            backup.token,
            backup.transientPaths,
            {
                label,
                expectedSha256: entry.sha256
            }
        );
    }
}

function promoteCandidateIndex(
    indexPath: string,
    candidateIndexPath: string,
    transientPaths: Set<string>
): void {
    const indexLockPath = `${indexPath}.lock`;
    fs.copyFileSync(candidateIndexPath, indexLockPath, fs.constants.COPYFILE_EXCL);
    transientPaths.add(indexLockPath);
    fs.renameSync(indexLockPath, indexPath);
    transientPaths.delete(indexLockPath);
}

export function applyAdvancedRestorePlan(
    repoRoot: string,
    plan: AdvancedRestorePlan,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[],
    selectedUntrackedFiles: SplitRequiredWipUntrackedFileEvidence[]
): string[] {
    const indexPath = currentIndexPath(repoRoot);
    const selectedPaths = selectedRestorePaths(selectedTrackedFiles, selectedUntrackedFiles);
    const freshnessViolation = validateRestorePlanFreshness(repoRoot, indexPath, plan, selectedPaths);
    if (freshnessViolation) {
        return [freshnessViolation];
    }
    const backup = captureRestoreBackup(repoRoot, indexPath, plan, selectedPaths);
    try {
        applyCandidateFiles(repoRoot, plan, backup, selectedTrackedFiles, selectedUntrackedFiles);
        promoteCandidateIndex(indexPath, plan.candidateIndexPath, backup.transientPaths);
        return [];
    } catch (error: unknown) {
        try {
            restoreFromBackup(repoRoot, indexPath, backup);
        } catch (rollbackError: unknown) {
            const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            return [`three-way restore failed and rollback failed: ${message}`];
        }
        const message = error instanceof Error ? error.message : String(error);
        return [`three-way restore failed without retained mutations: ${message}`];
    }
}

function validateArtifactHash(
    label: string,
    artifactPath: string,
    expectedSha256: string
): string | null {
    if (!expectedSha256) {
        return `${label} sha256 is missing.`;
    }
    if (!fs.existsSync(artifactPath)) {
        return `${label} artifact is missing: ${normalizePath(artifactPath)}`;
    }
    if (fs.lstatSync(artifactPath).isSymbolicLink()) {
        return `${label} artifact must not be a symbolic link: ${normalizePath(artifactPath)}`;
    }
    if (!fs.statSync(artifactPath).isFile()) {
        return `${label} artifact is not a file: ${normalizePath(artifactPath)}`;
    }
    const actualSha256 = sha256FileRequired(artifactPath);
    return actualSha256 === expectedSha256
        ? null
        : `${label} sha256 mismatch: expected=${expectedSha256}; actual=${actualSha256}`;
}

function validateReferencedArtifact(
    repoRoot: string,
    label: string,
    inputPath: string,
    expectedSha256: string
): string | null {
    try {
        const artifactPath = resolveInputPathInsideRepo(repoRoot, inputPath, label);
        return validateArtifactHash(label, artifactPath, expectedSha256);
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
    }
}

export function validateManifestFileReferences(
    repoRoot: string,
    manifest: SplitRequiredWipManifest
): string[] {
    if (!isPlainRecord(manifest.patches)
        || !isPlainRecord(manifest.patches.staged)
        || !isPlainRecord(manifest.patches.unstaged)) {
        return ['WIP manifest patch references are missing or invalid.'];
    }
    const violations: string[] = [];
    for (const [label, patch] of [
        ['staged patch', manifest.patches.staged],
        ['unstaged patch', manifest.patches.unstaged]
    ] as const) {
        const violation = validateReferencedArtifact(repoRoot, label, patch.path, patch.sha256);
        if (violation) {
            violations.push(violation);
        }
    }
    for (const entry of manifest.untracked_files || []) {
        const label = `untracked artifact ${entry.path}`;
        const violation = validateReferencedArtifact(repoRoot, label, entry.artifact_path, entry.sha256);
        if (violation) {
            violations.push(violation);
        }
    }
    return violations;
}
