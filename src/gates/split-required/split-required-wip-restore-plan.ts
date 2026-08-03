import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    readGitTreeEntriesForPaths,
    runGit
} from '../../core/git-helpers';
import type { GitTreeEntry } from '../../core/git-helpers';
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

const GIT_RESTORE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

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
    environment: NodeJS.ProcessEnv = process.env,
    input?: string | Buffer
): {
    status: number;
    stdout: string;
    stderr: string;
} {
    const result = childProcess.spawnSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        env: environment,
        input,
        maxBuffer: GIT_RESTORE_MAX_BUFFER_BYTES,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
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

function writeIndexTree(repoRoot: string, indexPath: string): string {
    const args = ['write-tree'];
    const result = runGitStatus(repoRoot, args, gitEnvironment(indexPath));
    if (result.status !== 0) {
        throw new Error(gitFailureMessage(args, result));
    }
    const treeObjectId = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/iu.test(treeObjectId)) {
        throw new Error('git write-tree returned malformed tree evidence.');
    }
    return treeObjectId;
}

interface UnmergedIndexEntry {
    mode: string;
    objectId: string;
    stage: 1 | 2 | 3;
}

interface IndexSnapshot {
    treeObjectId: string;
    unmergedEntries: Map<string, UnmergedIndexEntry[]>;
}

interface SelectedIndexState {
    entries: Map<string, GitTreeEntry>;
    unmergedPaths: Set<string>;
}

function readUnmergedIndexEntries(repoRoot: string, indexPath: string): Map<string, UnmergedIndexEntry[]> {
    const args = ['ls-files', '--unmerged', '--stage', '-z'];
    const result = runGitStatus(repoRoot, args, gitEnvironment(indexPath));
    if (result.status !== 0) {
        throw new Error(gitFailureMessage(args, result));
    }
    const entries = new Map<string, UnmergedIndexEntry[]>();
    for (const record of result.stdout.split('\0')) {
        if (!record) continue;
        const separatorIndex = record.indexOf('\t');
        const metadata = separatorIndex >= 0 ? record.slice(0, separatorIndex).split(' ') : [];
        const relativePath = separatorIndex >= 0 ? normalizeGitPath(record.slice(separatorIndex + 1)) : '';
        const [mode, objectId, stageText] = metadata;
        if (!/^[0-7]{6}$/u.test(mode || '')
            || !/^[0-9a-f]{40,64}$/iu.test(objectId || '')
            || !/^[123]$/u.test(stageText || '')
            || !relativePath) {
            throw new Error('git ls-files returned malformed unmerged index evidence.');
        }
        const pathEntries = entries.get(relativePath) || [];
        pathEntries.push({
            mode,
            objectId,
            stage: Number(stageText) as 1 | 2 | 3
        });
        entries.set(relativePath, pathEntries);
    }
    for (const pathEntries of entries.values()) {
        pathEntries.sort((left, right) => left.stage - right.stage);
    }
    return entries;
}

function snapshotIndex(repoRoot: string, indexPath: string): IndexSnapshot {
    try {
        return {
            treeObjectId: writeIndexTree(repoRoot, indexPath),
            unmergedEntries: new Map()
        };
    } catch (writeTreeError: unknown) {
        const unmergedEntries = readUnmergedIndexEntries(repoRoot, indexPath);
        if (unmergedEntries.size === 0) {
            throw writeTreeError;
        }
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-index-snapshot-'));
        const snapshotIndexPath = path.join(tempRoot, 'index');
        try {
            fs.copyFileSync(indexPath, snapshotIndexPath);
            const objectIdLength = [...unmergedEntries.values()][0][0].objectId.length;
            const zeroObjectId = '0'.repeat(objectIdLength);
            const removalInput = [...unmergedEntries.keys()]
                .sort()
                .map((relativePath) => `0 ${zeroObjectId}\t${relativePath}\0`)
                .join('');
            const removeArgs = ['update-index', '-z', '--index-info'];
            const removed = runGitStatus(
                repoRoot,
                removeArgs,
                gitEnvironment(snapshotIndexPath),
                Buffer.from(removalInput, 'utf8')
            );
            if (removed.status !== 0) {
                throw new Error(gitFailureMessage(removeArgs, removed));
            }
            return {
                treeObjectId: writeIndexTree(repoRoot, snapshotIndexPath),
                unmergedEntries
            };
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
    }
}

function selectedIndexState(
    repoRoot: string,
    indexPath: string,
    selectedPaths: Iterable<string>
): SelectedIndexState {
    const normalizedPaths = [...new Set([...selectedPaths].map(normalizeGitPath).filter(Boolean))];
    const snapshot = snapshotIndex(repoRoot, indexPath);
    return {
        entries: readGitTreeEntriesForPaths(repoRoot, snapshot.treeObjectId, normalizedPaths),
        unmergedPaths: new Set(normalizedPaths.filter((relativePath) => snapshot.unmergedEntries.has(relativePath)))
    };
}

function selectedIndexEntries(
    repoRoot: string,
    indexPath: string,
    selectedPaths: Iterable<string>
): Map<string, GitTreeEntry> {
    return selectedIndexState(repoRoot, indexPath, selectedPaths).entries;
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
        const selectedPaths = selectedTrackedFiles.map((entry) => normalizeGitPath(entry.path));
        const currentIndexState = selectedIndexState(repoRoot, currentIndexPath(repoRoot), selectedPaths);
        return selectedPaths
            .filter((relativePath) => fileStateSha256(resolveRepoPath(repoRoot, relativePath)) !== null)
            .filter((relativePath) => (
                !currentIndexState.entries.has(relativePath)
                && !currentIndexState.unmergedPaths.has(relativePath)
            ))
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
    const beforeSnapshot = snapshotIndex(repoRoot, beforeIndexPath);
    const afterSnapshot = snapshotIndex(repoRoot, afterIndexPath);
    const unauthorized = new Set<string>();
    const unmergedPaths = new Set([
        ...beforeSnapshot.unmergedEntries.keys(),
        ...afterSnapshot.unmergedEntries.keys()
    ]);
    for (const relativePath of unmergedPaths) {
        const beforeEntries = beforeSnapshot.unmergedEntries.get(relativePath) || [];
        const afterEntries = afterSnapshot.unmergedEntries.get(relativePath) || [];
        if (!selectedPaths.has(relativePath)
            && JSON.stringify(beforeEntries) !== JSON.stringify(afterEntries)) {
            unauthorized.add(relativePath);
        }
    }
    const args = [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '--no-renames',
        '-r',
        '-z',
        beforeSnapshot.treeObjectId,
        afterSnapshot.treeObjectId
    ];
    const result = runGitStatus(repoRoot, args);
    if (result.status !== 0) {
        throw new Error(gitFailureMessage(args, result));
    }
    for (const relativePath of result.stdout.split('\0')
        .map(normalizeGitPath)
        .filter(Boolean)
        .filter((entry) => !selectedPaths.has(entry))) {
        unauthorized.add(relativePath);
    }
    return [...unauthorized].sort();
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
    if (selectedPaths.size === 0) {
        return [];
    }
    const violations: string[] = [];
    const dirtyPaths = new Set<string>();
    const normalizedPaths = new Set([...selectedPaths].map(normalizeGitPath));
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-selected-index-'));
    const selectedIndexPath = path.join(tempRoot, 'index');
    try {
        const currentIndexState = selectedIndexState(repoRoot, currentIndexPath(repoRoot), normalizedPaths);
        const currentEntries = currentIndexState.entries;
        const headEntries = readGitTreeEntriesForPaths(repoRoot, getHeadCommit(repoRoot), normalizedPaths);
        for (const relativePath of normalizedPaths) {
            if (currentIndexState.unmergedPaths.has(relativePath)
                || JSON.stringify(currentEntries.get(relativePath) || null) !== JSON.stringify(headEntries.get(relativePath) || null)) {
                dirtyPaths.add(relativePath);
            }
        }

        const emptyArgs = ['read-tree', '--empty'];
        const emptyIndex = runGitStatus(repoRoot, emptyArgs, gitEnvironment(selectedIndexPath));
        if (emptyIndex.status !== 0) {
            throw new Error(gitFailureMessage(emptyArgs, emptyIndex));
        }
        if (currentEntries.size > 0) {
            const indexInfo = [...currentEntries]
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([relativePath, entry]) => `${entry.mode} ${entry.objectId}\t${relativePath}\0`)
                .join('');
            const updateArgs = ['update-index', '-z', '--index-info'];
            const updated = runGitStatus(
                repoRoot,
                updateArgs,
                gitEnvironment(selectedIndexPath),
                Buffer.from(indexInfo, 'utf8')
            );
            if (updated.status !== 0) {
                throw new Error(gitFailureMessage(updateArgs, updated));
            }
        }
        const refreshArgs = ['update-index', '--refresh'];
        const refreshed = runGitStatus(repoRoot, refreshArgs, gitEnvironment(selectedIndexPath));
        if (refreshed.status !== 0 && refreshed.status !== 1) {
            throw new Error(gitFailureMessage(refreshArgs, refreshed));
        }
        const diffArgs = ['diff-files', '--name-only', '--no-renames', '-z'];
        const diff = runGitStatus(repoRoot, diffArgs, gitEnvironment(selectedIndexPath));
        if (diff.status !== 0) {
            throw new Error(gitFailureMessage(diffArgs, diff));
        }
        for (const entry of diff.stdout.split('\0')) {
            if (entry) dirtyPaths.add(normalizeGitPath(entry));
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`failed to inspect selected restore targets: ${message}`);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    for (const relativePath of [...normalizedPaths].sort()) {
        if (dirtyPaths.has(relativePath)) {
            violations.push(`selected restore target is dirty: ${relativePath}`);
        }
    }
    return violations;
}

export function validateNoSymlinkPaths(repoRoot: string, relativePaths: Iterable<string>): string[] {
    const violations: string[] = [];
    const root = path.resolve(repoRoot);
    const normalizedPaths = [...new Set([...relativePaths].map(normalizeGitPath))].sort();
    for (const relativePath of normalizedPaths) {
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
    }
    if (normalizedPaths.length === 0) {
        return violations;
    }
    let headEntries: ReadonlyMap<string, GitTreeEntry>;
    try {
        headEntries = readGitTreeEntriesForPaths(repoRoot, 'HEAD', normalizedPaths);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`failed to inspect selected restore targets in HEAD: ${message}`);
        return violations;
    }
    for (const relativePath of normalizedPaths) {
        if (headEntries.get(relativePath)?.mode === '120000') {
            violations.push(`selected restore target is a symbolic link in HEAD: ${relativePath}`);
        }
    }
    return violations;
}

export function validateNoSymlinkPath(repoRoot: string, relativePath: string): string[] {
    return validateNoSymlinkPaths(repoRoot, [relativePath]);
}

export function validateAdvancedManifestBlobs(
    repoRoot: string,
    manifest: SplitRequiredWipManifest,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): string[] {
    const violations: string[] = [];
    if (selectedTrackedFiles.length === 0) {
        const commitCheck = runGitStatus(repoRoot, ['cat-file', '-e', `${manifest.base_commit}^{commit}`]);
        return commitCheck.status === 0
            ? []
            : [`manifest base commit is missing or invalid: ${manifest.base_commit}`];
    }

    let baseEntries: ReadonlyMap<string, GitTreeEntry>;
    try {
        baseEntries = readGitTreeEntriesForPaths(
            repoRoot,
            manifest.base_commit,
            selectedTrackedFiles.map((entry) => entry.path)
        );
    } catch {
        return [`manifest base commit is missing or invalid: ${manifest.base_commit}`];
    }

    const expectedObjectIds = [...new Set(
        selectedTrackedFiles
            .map((entry) => entry.head_sha256)
            .filter((objectId): objectId is string => Boolean(objectId))
    )].sort();
    const objectTypes = new Map<string, string>();
    if (expectedObjectIds.length > 0) {
        const args = ['cat-file', '--batch-check=%(objectname) %(objecttype)'];
        const checked = runGitStatus(
            repoRoot,
            args,
            process.env,
            `${expectedObjectIds.join('\n')}\n`
        );
        if (checked.status !== 0) {
            return [gitFailureMessage(args, checked)];
        }
        for (const line of checked.stdout.split(/\r?\n/gu)) {
            const [objectId, objectType] = line.trim().split(/\s+/u);
            if (objectId && objectType) {
                objectTypes.set(objectId, objectType);
            }
        }
    }

    for (const entry of selectedTrackedFiles) {
        const normalizedPath = normalizeGitPath(entry.path);
        const baseEntry = baseEntries.get(normalizedPath);
        if (!entry.head_sha256) {
            if (baseEntry) {
                violations.push(`manifest base blob evidence is missing for tracked path: ${entry.path}`);
            }
            continue;
        }
        if (objectTypes.get(entry.head_sha256) !== 'blob') {
            violations.push(`manifest base blob is missing: path=${entry.path}; blob=${entry.head_sha256}`);
            continue;
        }
        if (baseEntry?.type !== 'blob' || baseEntry.objectId !== entry.head_sha256) {
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
    let indexEntries: Map<string, GitTreeEntry>;
    try {
        indexEntries = selectedIndexEntries(
            repoRoot,
            workspace.unstagedIndexPath,
            selectedTrackedFiles.map((entry) => normalizeGitPath(entry.path))
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return `failed to inspect candidate index targets: ${message}`;
    }
    const checkoutPaths: string[] = [];
    for (const entry of selectedTrackedFiles) {
        const relativePath = normalizeGitPath(entry.path);
        const stageZeroEntry = indexEntries.get(relativePath);
        if (!stageZeroEntry) {
            continue;
        }
        if (stageZeroEntry.mode === '120000') {
            return `candidate index target is a symbolic link: ${entry.path}`;
        }
        if (!stageZeroEntry.mode.startsWith('100')) {
            return `candidate index target is not a regular file: ${entry.path}`;
        }
        checkoutPaths.push(relativePath);
    }
    if (checkoutPaths.length > 0) {
        const args = [
            'checkout-index',
            '--force',
            `--prefix=${normalizePath(workspace.candidateWorktreeRoot)}/`,
            '-z',
            '--stdin'
        ];
        const checkedOut = runGitStatus(
            repoRoot,
            args,
            environment,
            Buffer.from(`${checkoutPaths.join('\0')}\0`, 'utf8')
        );
        if (checkedOut.status !== 0) {
            return gitFailureMessage(args, checkedOut);
        }
    }
    return null;
}

function validateCandidateTrackedFiles(
    workspace: RestorePlanWorkspace,
    selectedTrackedFiles: SplitRequiredWipTrackedFileEvidence[]
): string | null {
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
            || validateCandidateTrackedFiles(workspace, selectedTrackedFiles);
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
