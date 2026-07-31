import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    runGit,
    runGitBinary,
    splitNulList
} from '../../core/git-helpers';
import { isPlainRecord } from '../../core/records';
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
    withFilesystemLock
} from '../../gate-runtime/timeline/task-events-locking';
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
import {
    REPAIR_ARTIFACT_SCHEMA_VERSION,
    WIP_MANIFEST_SCHEMA_VERSION,
    buildNextStepCommand,
    buildRestoreFullSuiteRepairWipCommand,
    fileBytes,
    formatFullSuiteRepairOutput,
    normalizeGitPath,
    nowIso,
    resolveRepoPath,
    sha256FileRequired,
    sha256Text,
    stableTimestampSlug,
    validateRepairChildTaskId,
    validateTaskTableTextField,
    writeJson
} from './full-suite-repair-contracts';
import type {
    CapturedPatchEvidence,
    CapturedUntrackedFileEvidence,
    FullSuiteRepairTaskMaterializationResult,
    FullSuiteRepairTaskProposal,
    FullSuiteRepairWipRestoreResult,
    MaterializeFullSuiteRepairTaskParams,
    ParentResumeStatusResult,
    PatchPathRecord,
    PreflightChangedFileScope,
    RepairTaskProposalReadResult,
    RepairWipManifest,
    RestoreFullSuiteRepairWipParams,
    RestoreMutationInspection,
    RestorePatchSnapshots,
    TaskQueueRowsMaterializationResult,
    TrackedChangeFiles
} from './full-suite-repair-contracts';
import {
    assertSingleLinkIdentity,
    getHeadCommit,
    gitFailureMessage,
    isContainedPath,
    isSha256,
    parseRepairWipManifest,
    resolveInputPathInsideRepo,
    restoreContainedUntrackedBytes,
    restoreContainedUntrackedFile,
    runGitStatus,
    runGitWithInput,
    sameFileIdentity,
    sameFileSnapshot,
    validateManifestRelativePath,
    validatePhysicalRepoContainment
} from './full-suite-repair-manifest';

export type {
    FullSuiteRepairTaskMaterializationResult,
    FullSuiteRepairTaskProposal,
    FullSuiteRepairWipRestoreResult
} from './full-suite-repair-contracts';

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
    const staged = new Set(
        splitNulList(runGitBinary(repoRoot, ['diff', '--name-only', '--no-renames', '--cached', '-z'])).map(normalizeGitPath)
    );
    const unstaged = new Set(
        splitNulList(runGitBinary(repoRoot, ['diff', '--name-only', '--no-renames', '-z'])).map(normalizeGitPath)
    );
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

function collectCapturedUntrackedFiles(repoRoot: string, taskId: string, allowedUntrackedFiles: Set<string>): string[] {
    return [...new Set([
        ...collectRuntimeTmpTaskOwnedUntrackedFiles(repoRoot, taskId),
        ...collectUntrackedFilesForPathspecs(repoRoot, [...allowedUntrackedFiles], true)
    ])].sort();
}

function validateUntrackedCaptureSource(repoRoot: string, relativePath: string): string[] {
    const sourcePath = resolveRepoPath(repoRoot, relativePath);
    const label = `untracked capture source ${relativePath}`;
    const violations = validatePhysicalRepoContainment(repoRoot, sourcePath, label);
    if (violations.length > 0) {
        return violations;
    }
    try {
        const identity = fs.lstatSync(sourcePath);
        if (identity.isSymbolicLink() || !identity.isFile()) {
            return [`${label} must be a regular file without symbolic links or junctions.`];
        }
        if (identity.nlink !== 1) {
            return [`${label} must not have additional hard links.`];
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`${label} cannot be inspected: ${message}`];
    }
    return [];
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

interface CaptureFileSnapshot {
    path: string;
    content: Buffer;
    identity: fs.Stats;
}

interface CapturedPatchSnapshot {
    evidence: CapturedPatchEvidence;
    snapshot: CaptureFileSnapshot;
}

function readImmutableRegularFileSnapshot(params: {
    filePath: string;
    label: string;
    repoRoot?: string;
}): CaptureFileSnapshot {
    if (params.repoRoot) {
        const containmentViolations = validatePhysicalRepoContainment(
            params.repoRoot,
            params.filePath,
            params.label
        );
        if (containmentViolations.length > 0) {
            throw new Error(containmentViolations.join(' '));
        }
    }
    const identityBeforeOpen = fs.lstatSync(params.filePath);
    assertSingleLinkIdentity(identityBeforeOpen, params.label);
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(params.filePath, fs.constants.O_RDONLY | noFollowFlag);
        const openedIdentity = fs.fstatSync(descriptor);
        assertSingleLinkIdentity(openedIdentity, params.label);
        if (!sameFileIdentity(identityBeforeOpen, openedIdentity)) {
            throw new Error(`${params.label} identity changed while opening.`);
        }
        const content = fs.readFileSync(descriptor);
        const finalOpenedIdentity = fs.fstatSync(descriptor);
        const pathIdentityAfterRead = fs.lstatSync(params.filePath);
        assertSingleLinkIdentity(finalOpenedIdentity, params.label);
        assertSingleLinkIdentity(pathIdentityAfterRead, params.label);
        if (!sameFileSnapshot(openedIdentity, finalOpenedIdentity)
            || !sameFileIdentity(finalOpenedIdentity, pathIdentityAfterRead)) {
            throw new Error(`${params.label} changed while reading.`);
        }
        if (params.repoRoot) {
            const finalContainmentViolations = validatePhysicalRepoContainment(
                params.repoRoot,
                params.filePath,
                params.label
            );
            if (finalContainmentViolations.length > 0) {
                throw new Error(finalContainmentViolations.join(' '));
            }
        }
        return {
            path: normalizePath(params.filePath),
            content,
            identity: finalOpenedIdentity
        };
    } finally {
        if (descriptor !== null) {
            fs.closeSync(descriptor);
        }
    }
}

function ensureContainedDirectoryPath(repoRoot: string, directoryPath: string, label: string): void {
    const root = path.resolve(repoRoot);
    const target = path.resolve(directoryPath);
    if (!isContainedPath(root, target)) {
        throw new Error(`${label} escapes repo root: ${normalizePath(target)}`);
    }
    const relativePath = path.relative(root, target);
    let currentPath = root;
    for (const segment of relativePath.split(path.sep).filter(Boolean)) {
        currentPath = path.join(currentPath, segment);
        if (!fs.existsSync(currentPath)) {
            fs.mkdirSync(currentPath);
        }
        const identity = fs.lstatSync(currentPath);
        if (identity.isSymbolicLink() || !identity.isDirectory()) {
            throw new Error(`${label} traverses a non-directory or symbolic-link component: ${normalizePath(currentPath)}`);
        }
        const containmentViolations = validatePhysicalRepoContainment(repoRoot, currentPath, label);
        if (containmentViolations.length > 0) {
            throw new Error(containmentViolations.join(' '));
        }
    }
}

function createExclusiveCaptureRoot(repoRoot: string, captureRoot: string): fs.Stats {
    ensureContainedDirectoryPath(repoRoot, path.dirname(captureRoot), 'prepared WIP capture parent');
    const containmentViolations = validatePhysicalRepoContainment(
        repoRoot,
        captureRoot,
        'prepared WIP capture root'
    );
    if (containmentViolations.length > 0) {
        throw new Error(containmentViolations.join(' '));
    }
    fs.mkdirSync(captureRoot);
    const identity = fs.lstatSync(captureRoot);
    if (identity.isSymbolicLink() || !identity.isDirectory()) {
        throw new Error(`prepared WIP capture root must be a newly created directory: ${normalizePath(captureRoot)}`);
    }
    return identity;
}

function writeExclusiveCaptureFile(
    repoRoot: string,
    filePath: string,
    content: Buffer,
    label: string
): CaptureFileSnapshot {
    ensureContainedDirectoryPath(repoRoot, path.dirname(filePath), `${label} parent`);
    const containmentViolations = validatePhysicalRepoContainment(repoRoot, filePath, label);
    if (containmentViolations.length > 0) {
        throw new Error(containmentViolations.join(' '));
    }
    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(
            filePath,
            fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollowFlag,
            0o600
        );
        const openedIdentity = fs.fstatSync(descriptor);
        assertSingleLinkIdentity(openedIdentity, label);
        fs.writeFileSync(descriptor, content);
        fs.fsyncSync(descriptor);
        const finalOpenedIdentity = fs.fstatSync(descriptor);
        const pathIdentity = fs.lstatSync(filePath);
        assertSingleLinkIdentity(finalOpenedIdentity, label);
        assertSingleLinkIdentity(pathIdentity, label);
        if (!sameFileIdentity(finalOpenedIdentity, pathIdentity)) {
            throw new Error(`${label} identity changed while writing.`);
        }
        const finalContainmentViolations = validatePhysicalRepoContainment(repoRoot, filePath, label);
        if (finalContainmentViolations.length > 0) {
            throw new Error(finalContainmentViolations.join(' '));
        }
        return {
            path: normalizePath(filePath),
            content: Buffer.from(content),
            identity: finalOpenedIdentity
        };
    } finally {
        if (descriptor !== null) {
            fs.closeSync(descriptor);
        }
    }
}

function readVerifiedCaptureFile(params: {
    repoRoot: string;
    filePath: string;
    label: string;
    expectedSha256: string;
    expectedBytes: number;
    expectedIdentity?: fs.Stats;
    expectedMode?: number;
}): CaptureFileSnapshot {
    const snapshot = readImmutableRegularFileSnapshot({
        repoRoot: params.repoRoot,
        filePath: params.filePath,
        label: params.label
    });
    if (params.expectedIdentity && !sameFileSnapshot(params.expectedIdentity, snapshot.identity)) {
        throw new Error(`${params.label} changed after exclusive creation.`);
    }
    if (params.expectedMode !== undefined && (snapshot.identity.mode & 0o777) !== params.expectedMode) {
        throw new Error(
            `${params.label} mode mismatch: expected=${params.expectedMode.toString(8)}; actual=${(snapshot.identity.mode & 0o777).toString(8)}`
        );
    }
    if (snapshot.content.byteLength !== params.expectedBytes) {
        throw new Error(
            `${params.label} byte count mismatch: expected=${params.expectedBytes}; actual=${snapshot.content.byteLength}`
        );
    }
    const actualSha256 = createHash('sha256').update(snapshot.content).digest('hex');
    if (actualSha256 !== params.expectedSha256) {
        throw new Error(
            `${params.label} sha256 mismatch: expected=${params.expectedSha256}; actual=${actualSha256}`
        );
    }
    return snapshot;
}

function buildPatchEvidence(filePath: string, content: Buffer): CapturedPatchEvidence {
    return {
        path: normalizePath(filePath),
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: content.byteLength,
        empty: content.byteLength === 0
    };
}

function writePatchFile(repoRoot: string, args: string[], outputPath: string): CapturedPatchSnapshot {
    const output = runGitBinary(repoRoot, args);
    return {
        evidence: buildPatchEvidence(outputPath, output),
        snapshot: writeExclusiveCaptureFile(repoRoot, outputPath, output, 'captured WIP patch')
    };
}

function writeEmptyPatchFile(repoRoot: string, outputPath: string): CapturedPatchSnapshot {
    const output = Buffer.alloc(0);
    return {
        evidence: buildPatchEvidence(outputPath, output),
        snapshot: writeExclusiveCaptureFile(repoRoot, outputPath, output, 'captured empty WIP patch')
    };
}

function writeScopedPatchFile(
    repoRoot: string,
    diffArgs: string[],
    relativePaths: Set<string>,
    outputPath: string
): CapturedPatchSnapshot {
    const sortedPaths = [...relativePaths].sort();
    if (sortedPaths.length === 0) {
        return writeEmptyPatchFile(repoRoot, outputPath);
    }
    return writePatchFile(repoRoot, [...diffArgs, '--', ...sortedPaths], outputPath);
}

function copyUntrackedTaskFile(repoRoot: string, captureRoot: string, relativePath: string): CapturedUntrackedFileEvidence {
    const sourcePath = resolveRepoPath(repoRoot, relativePath);
    const artifactPath = path.join(captureRoot, 'untracked', normalizeGitPath(relativePath));
    const sourceViolations = validateUntrackedCaptureSource(repoRoot, relativePath);
    if (sourceViolations.length > 0) {
        throw new Error(sourceViolations.join(' '));
    }
    const sourceIdentityBeforeCopy = fs.lstatSync(sourcePath);
    assertSingleLinkIdentity(sourceIdentityBeforeCopy, `untracked capture source ${relativePath}`);
    const sourceMode = sourceIdentityBeforeCopy.mode & 0o777;
    ensureContainedDirectoryPath(repoRoot, path.dirname(artifactPath), `untracked capture artifact ${relativePath} parent`);
    const artifactContainment = validatePhysicalRepoContainment(
        repoRoot,
        artifactPath,
        `untracked capture artifact ${relativePath}`
    );
    if (artifactContainment.length > 0) {
        throw new Error(artifactContainment.join(' '));
    }
    fs.copyFileSync(sourcePath, artifactPath, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(artifactPath, sourceMode);
    const sourceContainmentAfterCopy = validatePhysicalRepoContainment(
        repoRoot,
        sourcePath,
        `untracked capture source ${relativePath}`
    );
    if (sourceContainmentAfterCopy.length > 0) {
        throw new Error(sourceContainmentAfterCopy.join(' '));
    }
    const sourceIdentityAfterCopy = fs.lstatSync(sourcePath);
    assertSingleLinkIdentity(sourceIdentityAfterCopy, `untracked capture source ${relativePath}`);
    if (!sameFileSnapshot(sourceIdentityBeforeCopy, sourceIdentityAfterCopy)) {
        throw new Error(`untracked capture source changed while copying: ${relativePath}`);
    }
    const artifactContainmentAfterCopy = validatePhysicalRepoContainment(
        repoRoot,
        artifactPath,
        `untracked capture artifact ${relativePath}`
    );
    if (artifactContainmentAfterCopy.length > 0) {
        throw new Error(artifactContainmentAfterCopy.join(' '));
    }
    const artifactIdentity = fs.lstatSync(artifactPath);
    assertSingleLinkIdentity(artifactIdentity, `untracked capture artifact ${relativePath}`);
    if ((artifactIdentity.mode & 0o777) !== sourceMode || artifactIdentity.size !== sourceIdentityBeforeCopy.size) {
        throw new Error(`untracked capture artifact metadata mismatch: ${relativePath}`);
    }
    return {
        path: normalizeGitPath(relativePath),
        artifact_path: normalizePath(artifactPath),
        sha256: sha256FileRequired(artifactPath),
        bytes: fileBytes(artifactPath),
        mode: sourceMode
    };
}

function removeFileIfExists(filePath: string): void {
    if (!fs.existsSync(filePath)) {
        return;
    }
    const identity = fs.lstatSync(filePath);
    assertSingleLinkIdentity(identity, `file removal target ${normalizePath(filePath)}`);
    fs.unlinkSync(filePath);
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

interface PreparedWipCapture {
    manifest: RepairWipManifest;
    capturedUntrackedFiles: string[];
    captureRoot: string;
    captureRootIdentity: fs.Stats;
    manifestSnapshot: CaptureFileSnapshot;
    patchSnapshots: {
        staged: CaptureFileSnapshot;
        unstaged: CaptureFileSnapshot;
    };
    untrackedSnapshots: Array<{
        entry: CapturedUntrackedFileEvidence;
        snapshot: CaptureFileSnapshot;
    }>;
}

function prepareWipCapture(params: {
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
}): PreparedWipCapture {
    const timestampUtc = params.timestampUtc;
    const captureRoot = params.captureRoot;
    let captureRootCreated = false;
    try {
        const captureRootIdentity = createExclusiveCaptureRoot(params.repoRoot, captureRoot);
        captureRootCreated = true;

        const capturedUntrackedFiles = collectCapturedUntrackedFiles(
            params.repoRoot,
            params.taskId,
            params.allowedUntrackedFiles
        );

        const stagedPatch = writeScopedPatchFile(
            params.repoRoot,
            ['diff', '--binary', '--no-renames', '--cached'],
            params.trackedChanges.staged,
            path.join(captureRoot, 'staged.patch')
        );
        const unstagedPatch = writeScopedPatchFile(
            params.repoRoot,
            ['diff', '--binary', '--no-renames'],
            params.trackedChanges.unstaged,
            path.join(captureRoot, 'unstaged.patch')
        );
        const untracked = capturedUntrackedFiles.map(
            (relativePath) => copyUntrackedTaskFile(params.repoRoot, captureRoot, relativePath)
        );
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
                staged: stagedPatch.evidence,
                unstaged: unstagedPatch.evidence
            },
            tracked_files: trackedFiles,
            untracked_files: untracked,
            unrelated_untracked_files: params.unrelatedVisibleUntrackedFiles
        };
        const manifestContent = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        const manifestSnapshot = writeExclusiveCaptureFile(
            params.repoRoot,
            path.join(captureRoot, 'manifest.json'),
            manifestContent,
            'captured WIP manifest'
        );
        const preparedCapture: PreparedWipCapture = {
            manifest,
            capturedUntrackedFiles,
            captureRoot,
            captureRootIdentity,
            manifestSnapshot,
            patchSnapshots: {
                staged: stagedPatch.snapshot,
                unstaged: unstagedPatch.snapshot
            },
            untrackedSnapshots: []
        };
        return verifyPreparedWipCapture(params.repoRoot, preparedCapture);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const cleanupViolations = captureRootCreated
            ? removePreparedWipCapture(params.repoRoot, captureRoot)
            : [];
        throw new Error([message, ...cleanupViolations].join(' '));
    }
}

function verifyPreparedWipCapture(repoRoot: string, preparedCapture: PreparedWipCapture): PreparedWipCapture {
    const rootContainmentViolations = validatePhysicalRepoContainment(
        repoRoot,
        preparedCapture.captureRoot,
        'prepared WIP capture verification'
    );
    if (rootContainmentViolations.length > 0) {
        throw new Error(rootContainmentViolations.join(' '));
    }
    const captureRootIdentity = fs.lstatSync(preparedCapture.captureRoot);
    if (!captureRootIdentity.isDirectory()
        || captureRootIdentity.isSymbolicLink()
        || !sameFileIdentity(preparedCapture.captureRootIdentity, captureRootIdentity)) {
        throw new Error('prepared WIP capture root identity changed after exclusive creation.');
    }
    const staged = readVerifiedCaptureFile({
        repoRoot,
        filePath: preparedCapture.manifest.patches.staged.path,
        label: 'captured staged WIP patch',
        expectedSha256: preparedCapture.manifest.patches.staged.sha256,
        expectedBytes: preparedCapture.manifest.patches.staged.bytes,
        expectedIdentity: preparedCapture.patchSnapshots.staged.identity
    });
    const unstaged = readVerifiedCaptureFile({
        repoRoot,
        filePath: preparedCapture.manifest.patches.unstaged.path,
        label: 'captured unstaged WIP patch',
        expectedSha256: preparedCapture.manifest.patches.unstaged.sha256,
        expectedBytes: preparedCapture.manifest.patches.unstaged.bytes,
        expectedIdentity: preparedCapture.patchSnapshots.unstaged.identity
    });
    const manifest = readVerifiedCaptureFile({
        repoRoot,
        filePath: preparedCapture.manifestSnapshot.path,
        label: 'captured WIP manifest',
        expectedSha256: createHash('sha256').update(preparedCapture.manifestSnapshot.content).digest('hex'),
        expectedBytes: preparedCapture.manifestSnapshot.content.byteLength,
        expectedIdentity: preparedCapture.manifestSnapshot.identity
    });
    if (!manifest.content.equals(preparedCapture.manifestSnapshot.content)) {
        throw new Error('captured WIP manifest content changed after exclusive creation.');
    }
    const untrackedSnapshots = preparedCapture.manifest.untracked_files.map((entry) => ({
        entry,
        snapshot: readVerifiedCaptureFile({
            repoRoot,
            filePath: resolveInputPathInsideRepo(repoRoot, entry.artifact_path, `untracked artifact ${entry.path}`),
            label: `captured untracked WIP artifact ${entry.path}`,
            expectedSha256: entry.sha256,
            expectedBytes: entry.bytes,
            expectedMode: entry.mode
        })
    }));
    return {
        ...preparedCapture,
        manifestSnapshot: manifest,
        patchSnapshots: { staged, unstaged },
        untrackedSnapshots
    };
}

function buildCurrentScopedPatch(
    repoRoot: string,
    diffArgs: string[],
    relativePaths: Set<string>
): Buffer {
    const sortedPaths = [...relativePaths].sort();
    return sortedPaths.length === 0
        ? Buffer.alloc(0)
        : runGitBinary(repoRoot, [...diffArgs, '--', ...sortedPaths]);
}

function validateCurrentUntrackedSnapshot(
    repoRoot: string,
    entry: CapturedUntrackedFileEvidence,
    expectedContent: Buffer
): string[] {
    const targetPath = resolveRepoPath(repoRoot, entry.path);
    const containmentViolations = validatePhysicalRepoContainment(
        repoRoot,
        targetPath,
        `prepared WIP source ${entry.path}`
    );
    if (containmentViolations.length > 0) {
        return containmentViolations;
    }
    if (!fs.existsSync(targetPath)) {
        return [`prepared WIP source is missing: ${entry.path}`];
    }
    try {
        const identity = fs.lstatSync(targetPath);
        assertSingleLinkIdentity(identity, `prepared WIP source ${entry.path}`);
        const content = fs.readFileSync(targetPath);
        if ((identity.mode & 0o777) !== entry.mode) {
            return [`prepared WIP source mode changed: ${entry.path}`];
        }
        if (!content.equals(expectedContent)) {
            return [`prepared WIP source content changed: ${entry.path}`];
        }
        return [];
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`prepared WIP source validation failed for ${entry.path}: ${message}`];
    }
}

function validateWorkspaceMatchesPreparedCapture(
    repoRoot: string,
    trackedChanges: TrackedChangeFiles,
    preparedCapture: PreparedWipCapture
): string[] {
    const violations: string[] = [];
    const currentTrackedChanges = collectTrackedChangeFiles(repoRoot);
    const expectedStaged = [...trackedChanges.staged].sort();
    const expectedUnstaged = [...trackedChanges.unstaged].sort();
    const currentStaged = [...currentTrackedChanges.staged].sort();
    const currentUnstaged = [...currentTrackedChanges.unstaged].sort();
    if (JSON.stringify(currentStaged) !== JSON.stringify(expectedStaged)) {
        violations.push(
            `staged WIP path set changed after capture: expected=${expectedStaged.join(',')}; actual=${currentStaged.join(',')}`
        );
    }
    if (JSON.stringify(currentUnstaged) !== JSON.stringify(expectedUnstaged)) {
        violations.push(
            `unstaged WIP path set changed after capture: expected=${expectedUnstaged.join(',')}; actual=${currentUnstaged.join(',')}`
        );
    }
    const currentStagedPatch = buildCurrentScopedPatch(
        repoRoot,
        ['diff', '--binary', '--no-renames', '--cached'],
        trackedChanges.staged
    );
    if (!currentStagedPatch.equals(preparedCapture.patchSnapshots.staged.content)) {
        violations.push('staged WIP content changed after capture.');
    }
    const currentUnstagedPatch = buildCurrentScopedPatch(
        repoRoot,
        ['diff', '--binary', '--no-renames'],
        trackedChanges.unstaged
    );
    if (!currentUnstagedPatch.equals(preparedCapture.patchSnapshots.unstaged.content)) {
        violations.push('unstaged WIP content changed after capture.');
    }
    for (const { entry, snapshot } of preparedCapture.untrackedSnapshots) {
        violations.push(...validateCurrentUntrackedSnapshot(repoRoot, entry, snapshot.content));
    }
    return violations;
}

function rollbackPreparedWipSuspension(
    repoRoot: string,
    trackedChanges: TrackedChangeFiles,
    preparedCapture: PreparedWipCapture
): string[] {
    const violations: string[] = [];
    try {
        suspendTrackedChanges(repoRoot, trackedChanges.all);
        if (hasPatchContent(preparedCapture.manifest.patches.staged)) {
            runGitWithInput(
                repoRoot,
                ['apply', '--check', '--index', '-'],
                preparedCapture.patchSnapshots.staged.content
            );
            runGitWithInput(
                repoRoot,
                ['apply', '--index', '-'],
                preparedCapture.patchSnapshots.staged.content
            );
        }
        if (hasPatchContent(preparedCapture.manifest.patches.unstaged)) {
            runGitWithInput(
                repoRoot,
                ['apply', '--check', '-'],
                preparedCapture.patchSnapshots.unstaged.content
            );
            runGitWithInput(
                repoRoot,
                ['apply', '-'],
                preparedCapture.patchSnapshots.unstaged.content
            );
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`failed to restore tracked WIP after suspension failure: ${message}`);
    }
    for (const { entry, snapshot } of preparedCapture.untrackedSnapshots) {
        const targetPath = resolveRepoPath(repoRoot, entry.path);
        if (fs.existsSync(targetPath)) {
            violations.push(...validateCurrentUntrackedSnapshot(repoRoot, entry, snapshot.content));
            continue;
        }
        try {
            restoreContainedUntrackedBytes({
                repoRoot,
                entry,
                content: snapshot.content
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`failed to restore untracked WIP after suspension failure for ${entry.path}: ${message}`);
        }
    }
    if (violations.length === 0) {
        violations.push(...validateWorkspaceMatchesPreparedCapture(repoRoot, trackedChanges, preparedCapture));
    }
    return violations;
}

function suspendPreparedWip(
    repoRoot: string,
    trackedChanges: TrackedChangeFiles,
    preparedCapture: PreparedWipCapture
): void {
    suspendTrackedChanges(repoRoot, trackedChanges.all);
    for (const relativePath of preparedCapture.capturedUntrackedFiles) {
        removeFileIfExists(resolveRepoPath(repoRoot, relativePath));
    }
}

function validatePreparedWipSuspended(
    repoRoot: string,
    preparedCapture: PreparedWipCapture
): string[] {
    const violations: string[] = [];
    const remainingTrackedChanges = collectTrackedChangeFiles(repoRoot);
    if (remainingTrackedChanges.all.length > 0) {
        violations.push(`tracked WIP remains after suspension: ${remainingTrackedChanges.all.join(', ')}`);
    }
    for (const relativePath of preparedCapture.capturedUntrackedFiles) {
        if (fs.existsSync(resolveRepoPath(repoRoot, relativePath))) {
            violations.push(`untracked WIP remains after suspension: ${relativePath}`);
        }
    }
    return violations;
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

function removePreparedWipCapture(repoRoot: string, captureRoot: string): string[] {
    const normalizedCaptureRoot = path.resolve(captureRoot);
    const wipRoot = path.resolve(joinOrchestratorPath(repoRoot, path.join('runtime', 'wip')));
    if (!isContainedPath(wipRoot, normalizedCaptureRoot) || normalizedCaptureRoot === wipRoot) {
        return [`prepared WIP capture cleanup refused path outside task capture root: ${normalizePath(normalizedCaptureRoot)}`];
    }
    const containmentViolations = validatePhysicalRepoContainment(
        repoRoot,
        normalizedCaptureRoot,
        'prepared WIP capture cleanup'
    );
    if (containmentViolations.length > 0) {
        return containmentViolations;
    }
    try {
        if (fs.existsSync(normalizedCaptureRoot)) {
            const identity = fs.lstatSync(normalizedCaptureRoot);
            if (identity.isSymbolicLink() || !identity.isDirectory()) {
                return [`prepared WIP capture cleanup refused non-directory target: ${normalizePath(normalizedCaptureRoot)}`];
            }
            fs.rmSync(normalizedCaptureRoot, { recursive: true, force: true });
        }
        return [];
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`prepared WIP capture cleanup failed: ${message}`];
    }
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
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    fullSuiteArtifactPath: string;
    childTaskId: string | null;
}): {
    materialized: boolean;
    reason: string;
    artifact_path: string;
    child_task_id?: string | null;
    wip_manifest_path?: string | null;
    wip_manifest_sha256?: string | null;
    split_required_artifact_path?: string | null;
} {
    let artifactPath = resolveFullSuiteRepairTaskArtifactPath(params.reviewsRoot, params.taskId);
    let artifact: unknown = null;
    try {
        const reviewsRoot = resolveInputPathInsideRepo(params.repoRoot, params.reviewsRoot, 'ReviewsRoot');
        artifactPath = resolveFullSuiteRepairTaskArtifactPath(reviewsRoot, params.taskId);
        const containmentViolations = validatePhysicalRepoContainment(
            params.repoRoot,
            artifactPath,
            'full-suite repair materialization artifact'
        );
        if (containmentViolations.length > 0) {
            return {
                materialized: false,
                reason: `full-suite repair materialization artifact is outside its physical repository boundary: ${containmentViolations.join(' ')}`,
                artifact_path: normalizePath(artifactPath)
            };
        }
        if (!fs.existsSync(artifactPath)) {
            return {
                materialized: false,
                reason: `full-suite repair materialization artifact is missing at ${normalizePath(artifactPath)}`,
                artifact_path: normalizePath(artifactPath)
            };
        }
        const artifactSnapshot = readImmutableRegularFileSnapshot({
            repoRoot: params.repoRoot,
            filePath: artifactPath,
            label: 'full-suite repair materialization artifact'
        });
        artifact = JSON.parse(artifactSnapshot.content.toString('utf8')) as unknown;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            materialized: false,
            reason: `full-suite repair materialization artifact cannot be read safely: ${message}`,
            artifact_path: normalizePath(artifactPath)
        };
    }
    if (!isPlainRecord(artifact)) {
        return {
            materialized: false,
            reason: `full-suite repair materialization artifact is invalid at ${normalizePath(artifactPath)}`,
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
    try {
        manifestPath = resolveInputPathInsideRepo(params.repoRoot, manifestPath, 'WipManifestPath');
    } catch {
        return { materialized: false, reason: 'full-suite repair WIP manifest path escapes repo root', artifact_path: normalizePath(artifactPath) };
    }
    const expectedManifestSha = String(artifact.wip_manifest_sha256 || '').trim();
    let manifestSnapshot: CaptureFileSnapshot;
    try {
        manifestSnapshot = readImmutableRegularFileSnapshot({
            repoRoot: params.repoRoot,
            filePath: manifestPath,
            label: 'full-suite repair WIP manifest'
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            materialized: false,
            reason: `full-suite repair WIP manifest cannot be read safely: ${message}`,
            artifact_path: normalizePath(artifactPath)
        };
    }
    const manifestBytes = manifestSnapshot.content;
    const actualManifestSha = createHash('sha256').update(manifestBytes).digest('hex');
    if (!isSha256(expectedManifestSha) || actualManifestSha !== expectedManifestSha) {
        return { materialized: false, reason: 'full-suite repair WIP manifest sha256 mismatch', artifact_path: normalizePath(artifactPath) };
    }
    let manifest: unknown = null;
    try {
        manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
    } catch {
        manifest = null;
    }
    const parsedManifest = parseRepairWipManifest(params.repoRoot, manifestPath, manifest);
    if (!parsedManifest.manifest) {
        return {
            materialized: false,
            reason: `full-suite repair WIP manifest schema is invalid: ${parsedManifest.violations.join(' ')}`,
            artifact_path: normalizePath(artifactPath)
        };
    }
    const parsedValue = parsedManifest.manifest;
    if (parsedValue.task_id !== params.taskId) {
        return { materialized: false, reason: 'full-suite repair WIP manifest task_id mismatch', artifact_path: normalizePath(artifactPath) };
    }
    if (params.childTaskId && parsedValue.child_task_id !== params.childTaskId) {
        return { materialized: false, reason: 'full-suite repair WIP manifest child_task_id mismatch', artifact_path: normalizePath(artifactPath) };
    }
    if (parsedValue.full_suite_artifact_sha256 !== expectedFullSuiteSha) {
        return { materialized: false, reason: 'full-suite repair WIP manifest is not bound to the current full-suite artifact', artifact_path: normalizePath(artifactPath) };
    }
    return {
        materialized: true,
        reason: 'full-suite repair task and WIP manifest are materialized',
        artifact_path: normalizePath(artifactPath),
        child_task_id: String(artifact.child_task_id || ''),
        wip_manifest_path: normalizePath(manifestPath),
        wip_manifest_sha256: expectedManifestSha,
        split_required_artifact_path: typeof artifact.split_required_artifact_path === 'string'
            ? normalizePath(artifact.split_required_artifact_path)
            : null
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
    const taskPath = path.join(params.repoRoot, TASK_QUEUE_FILENAME);
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

interface OptionalControlPlaneFileSnapshot {
    path: string;
    existed: boolean;
    content: Buffer | null;
    mode: number | null;
}

function snapshotOptionalControlPlaneFile(
    repoRoot: string,
    filePath: string,
    label: string
): OptionalControlPlaneFileSnapshot {
    const resolvedPath = resolveInputPathInsideRepo(repoRoot, filePath, label);
    const containmentViolations = validatePhysicalRepoContainment(repoRoot, resolvedPath, label);
    if (containmentViolations.length > 0) {
        throw new Error(containmentViolations.join(' '));
    }
    if (!fs.existsSync(resolvedPath)) {
        return {
            path: resolvedPath,
            existed: false,
            content: null,
            mode: null
        };
    }
    const identityBeforeRead = fs.lstatSync(resolvedPath);
    assertSingleLinkIdentity(identityBeforeRead, label);
    const content = fs.readFileSync(resolvedPath);
    const identityAfterRead = fs.lstatSync(resolvedPath);
    assertSingleLinkIdentity(identityAfterRead, label);
    if (!sameFileSnapshot(identityBeforeRead, identityAfterRead)) {
        throw new Error(`${label} changed while taking the transaction snapshot.`);
    }
    return {
        path: resolvedPath,
        existed: true,
        content,
        mode: identityAfterRead.mode & 0o777
    };
}

function restoreOptionalControlPlaneFile(
    repoRoot: string,
    snapshot: OptionalControlPlaneFileSnapshot,
    label: string
): string[] {
    const containmentViolations = validatePhysicalRepoContainment(repoRoot, snapshot.path, label);
    if (containmentViolations.length > 0) {
        return containmentViolations;
    }
    try {
        if (!snapshot.existed) {
            if (!fs.existsSync(snapshot.path)) {
                return [];
            }
            const identity = fs.lstatSync(snapshot.path);
            assertSingleLinkIdentity(identity, label);
            fs.unlinkSync(snapshot.path);
            return [];
        }
        if (!snapshot.content) {
            return [`${label} snapshot content is missing.`];
        }
        ensureContainedDirectoryPath(repoRoot, path.dirname(snapshot.path), `${label} parent`);
        if (fs.existsSync(snapshot.path)) {
            const currentIdentity = fs.lstatSync(snapshot.path);
            assertSingleLinkIdentity(currentIdentity, label);
        }
        const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
        const descriptor = fs.openSync(
            snapshot.path,
            fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY | noFollowFlag,
            0o600
        );
        try {
            const openedIdentity = fs.fstatSync(descriptor);
            assertSingleLinkIdentity(openedIdentity, label);
            fs.writeFileSync(descriptor, snapshot.content);
            if (snapshot.mode !== null) {
                fs.fchmodSync(descriptor, snapshot.mode);
            }
            fs.fsyncSync(descriptor);
            const pathIdentity = fs.lstatSync(snapshot.path);
            if (!sameFileIdentity(openedIdentity, pathIdentity)) {
                throw new Error(`${label} identity changed while restoring the transaction snapshot.`);
            }
        } finally {
            fs.closeSync(descriptor);
        }
        const restoredContent = fs.readFileSync(snapshot.path);
        return restoredContent.equals(snapshot.content)
            ? []
            : [`${label} content does not match its transaction snapshot after rollback.`];
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`${label} rollback failed: ${message}`];
    }
}

function readTaskStatusFromControlPlaneSnapshot(
    snapshot: OptionalControlPlaneFileSnapshot,
    taskId: string
): string | null {
    if (!snapshot.existed || !snapshot.content) {
        return null;
    }
    const row = parseCanonicalActiveTaskQueue(snapshot.content.toString('utf8'))
        .rows
        .find((candidate) => candidate.taskId === taskId);
    return row ? readTaskQueueStatusToken(row.status) : null;
}

function restoreTaskQueueTransactionSnapshot(
    repoRoot: string,
    snapshot: OptionalControlPlaneFileSnapshot
): string[] {
    try {
        return withTaskQueueStatusSyncLock<string[]>(
            snapshot.path,
            (message) => [`TASK.md transaction rollback failed: ${message}`],
            () => restoreOptionalControlPlaneFile(repoRoot, snapshot, 'TASK.md transaction snapshot')
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`TASK.md transaction rollback failed: ${message}`];
    }
}

function buildBlockedMaterializationResult(params: {
    repoRoot: string;
    taskId: string;
    proposal: FullSuiteRepairTaskProposal;
    artifactPath: string;
    preflightPath: string;
    fullSuiteArtifactPath: string;
    timestampUtc: string;
    queueResult: TaskQueueRowsMaterializationResult | null;
    splitRequiredArtifactPath: string | null;
    splitRequiredArtifactSha256: string | null;
    retainedManifestPath: string | null;
    priorMaterializationArtifactSnapshot: OptionalControlPlaneFileSnapshot | null;
    violations: string[];
}): FullSuiteRepairTaskMaterializationResult {
    let blockedArtifactPath = params.artifactPath;
    if (params.priorMaterializationArtifactSnapshot?.existed) {
        const timestampSlug = stableTimestampSlug(params.timestampUtc);
        const failureStem = `${params.artifactPath}.failure-${timestampSlug}`;
        let suffix = 0;
        do {
            blockedArtifactPath = `${failureStem}${suffix === 0 ? '' : `-${suffix}`}.json`;
            suffix += 1;
        } while (fs.existsSync(blockedArtifactPath));
    }
    const blockedArtifact = {
        schema_version: REPAIR_ARTIFACT_SCHEMA_VERSION,
        status: 'BLOCKED',
        task_id: params.taskId,
        child_task_id: params.proposal.suggested_task_id,
        created_at_utc: params.timestampUtc,
        proposal: params.proposal,
        preflight_path: normalizePath(params.preflightPath),
        preflight_sha256: fileSha256(params.preflightPath),
        full_suite_artifact_path: normalizePath(params.fullSuiteArtifactPath),
        full_suite_artifact_sha256: fileSha256(params.fullSuiteArtifactPath),
        wip_manifest_path: params.retainedManifestPath
            ? normalizePath(params.retainedManifestPath)
            : null,
        wip_manifest_sha256: params.retainedManifestPath && fs.existsSync(params.retainedManifestPath)
            ? fileSha256(params.retainedManifestPath)
            : null,
        split_required_artifact_path: params.splitRequiredArtifactPath,
        split_required_artifact_sha256: params.splitRequiredArtifactSha256,
        task_queue: params.queueResult,
        violations: params.violations
    };
    try {
        if (params.priorMaterializationArtifactSnapshot?.existed) {
            writeExclusiveCaptureFile(
                params.repoRoot,
                blockedArtifactPath,
                Buffer.from(`${JSON.stringify(blockedArtifact, null, 2)}\n`, 'utf8'),
                'blocked repair materialization failure artifact'
            );
        } else {
            writeJson(blockedArtifactPath, blockedArtifact);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        params.violations.push(`failed to persist blocked repair materialization artifact: ${message}`);
    }
    try {
        appendMandatoryTaskEvent(
            joinOrchestratorPath(params.repoRoot, ''),
            params.taskId,
            'FULL_SUITE_REPAIR_TASK_MATERIALIZED',
            'FAIL',
            'Full-suite timeout repair task materialization failed and transactional rollback was attempted.',
            {
                artifact_path: normalizePath(blockedArtifactPath),
                artifact_sha256: fs.existsSync(blockedArtifactPath) ? fileSha256(blockedArtifactPath) : null,
                child_task_id: params.proposal.suggested_task_id,
                wip_manifest_path: params.retainedManifestPath
                    ? normalizePath(params.retainedManifestPath)
                    : null,
                split_required_artifact_path: params.splitRequiredArtifactPath,
                violations: params.violations
            },
            { actor: 'orchestrator' }
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        params.violations.push(`failed to record blocked repair materialization event: ${message}`);
        if (!params.priorMaterializationArtifactSnapshot?.existed) {
            try {
                writeJson(blockedArtifactPath, {
                    ...blockedArtifact,
                    violations: params.violations
                });
            } catch {
                // The primary violation already records that durable failure evidence could not be committed.
            }
        }
    }
    return {
        status: 'BLOCKED',
        task_id: params.taskId,
        child_task_id: params.proposal.suggested_task_id,
        artifact_path: normalizePath(blockedArtifactPath),
        wip_manifest_path: params.retainedManifestPath
            ? normalizePath(params.retainedManifestPath)
            : null,
        split_required_artifact_path: params.splitRequiredArtifactPath,
        violations: params.violations,
        output_lines: formatFullSuiteRepairOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            status: 'BLOCKED',
            action: 'Resolve repair task materialization failures before retrying.',
            reason: params.violations.join(' '),
            detailsPath: blockedArtifactPath,
            legacyLines: [
                'FULL_SUITE_REPAIR_TASK_BLOCKED',
                `TaskId: ${params.taskId}`,
                `ChildTaskId: ${params.proposal.suggested_task_id}`,
                `ArtifactPath: ${normalizePath(blockedArtifactPath)}`,
                ...params.violations.map((violation) => `Violation: ${violation}`)
            ]
        })
    };
}

function materializeFullSuiteRepairTaskUnlocked(
    params: MaterializeFullSuiteRepairTaskParams
): FullSuiteRepairTaskMaterializationResult {
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
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                status: 'BLOCKED',
                action: 'Fix full-suite repair proposal evidence before retrying materialization.',
                reason: violations.join(' '),
                detailsPath: fullSuiteArtifactPath,
                legacyLines: ['FULL_SUITE_REPAIR_TASK_BLOCKED', ...violations.map((violation) => `Violation: ${violation}`)]
            })
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
            wip_manifest_path: currentEvidence.wip_manifest_path || null,
            split_required_artifact_path: currentEvidence.split_required_artifact_path || null,
            violations: [],
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                status: 'ALREADY_MATERIALIZED',
                action: 'Continue parent routing through the existing repair child.',
                reason: currentEvidence.reason,
                detailsPath: artifactPath,
                legacyLines: [
                    'FULL_SUITE_REPAIR_TASK_ALREADY_MATERIALIZED',
                    `ChildTaskId: ${proposal.suggested_task_id}`,
                    `ArtifactPath: ${normalizePath(artifactPath)}`,
                    `Reason: ${currentEvidence.reason}`
                ]
            })
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
    for (const relativePath of collectCapturedUntrackedFiles(repoRoot, params.taskId, preflightScope.allowed)) {
        scopeViolations.push(...validateUntrackedCaptureSource(repoRoot, relativePath));
    }
    const wipCapture = planWipCaptureLocation(repoRoot, params.taskId);
    let preparedCapture: PreparedWipCapture | null = null;
    if (scopeViolations.length === 0) {
        try {
            preparedCapture = prepareWipCapture({
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
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            scopeViolations.push(`WIP capture preparation failed before durable task mutation: ${message}`);
        }
    }
    if (preparedCapture && scopeViolations.length === 0) {
        try {
            preparedCapture = verifyPreparedWipCapture(repoRoot, preparedCapture);
            scopeViolations.push(
                ...validateWorkspaceMatchesPreparedCapture(repoRoot, trackedChanges, preparedCapture)
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            scopeViolations.push(`WIP capture verification failed before durable task mutation: ${message}`);
        }
        if (scopeViolations.length > 0) {
            scopeViolations.push(...removePreparedWipCapture(repoRoot, wipCapture.captureRoot));
        }
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
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                status: 'BLOCKED',
                action: 'Resolve repair materialization scope blockers before retrying.',
                reason: scopeViolations.join(' '),
                detailsPath: artifactPath,
                legacyLines: [
                    'FULL_SUITE_REPAIR_TASK_BLOCKED',
                    `TaskId: ${params.taskId}`,
                    `ChildTaskId: ${proposal.suggested_task_id}`,
                    `ArtifactPath: ${normalizePath(artifactPath)}`,
                    ...scopeViolations.map((violation) => `Violation: ${violation}`)
                ]
            })
        };
    }

    if (!preparedCapture) {
        throw new Error('prepared WIP capture missing after successful capture preconditions');
    }
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const splitRequiredArtifactPath = path.join(reviewsRoot, `${params.taskId}-split-required.json`);
    let taskSnapshot: OptionalControlPlaneFileSnapshot;
    let splitRequiredSnapshot: OptionalControlPlaneFileSnapshot;
    let materializationArtifactSnapshot: OptionalControlPlaneFileSnapshot;
    try {
        taskSnapshot = snapshotOptionalControlPlaneFile(repoRoot, taskPath, 'TASK.md transaction snapshot');
        splitRequiredSnapshot = snapshotOptionalControlPlaneFile(
            repoRoot,
            splitRequiredArtifactPath,
            'split-required transaction snapshot'
        );
        materializationArtifactSnapshot = snapshotOptionalControlPlaneFile(
            repoRoot,
            artifactPath,
            'repair materialization artifact transaction snapshot'
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const snapshotViolations = [
            `repair materialization transaction snapshot failed: ${message}`,
            ...removePreparedWipCapture(repoRoot, wipCapture.captureRoot)
        ];
        return {
            status: 'BLOCKED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: null,
            split_required_artifact_path: null,
            violations: snapshotViolations,
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                status: 'BLOCKED',
                action: 'Resolve repair materialization snapshot blockers before retrying.',
                reason: snapshotViolations.join(' '),
                detailsPath: artifactPath,
                legacyLines: [
                    'FULL_SUITE_REPAIR_TASK_BLOCKED',
                    ...snapshotViolations.map((violation) => `Violation: ${violation}`)
                ]
            })
        };
    }

    let queueResult: TaskQueueRowsMaterializationResult | null = null;
    let latchResult: ReturnType<typeof materializeSplitRequiredLatch> | null = null;
    let suspensionStarted = false;
    try {
        queueResult = materializeTaskQueueRows({
            repoRoot,
            parentTaskId: params.taskId,
            proposal,
            manifestPath: wipCapture.manifestPath
        });
        if (queueResult.outcome === 'task_file_missing'
            || queueResult.outcome === 'task_not_found'
            || queueResult.outcome === 'write_failed') {
            throw new Error(
                `TASK.md repair child materialization failed: ${queueResult.outcome}`
                + `${queueResult.error_message ? ` (${queueResult.error_message})` : ''}.`
            );
        }

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
            throw new Error(
                `Split-required latch failed: ${latchResult.status_sync.outcome}`
                + `${latchResult.status_sync.error_message ? ` (${latchResult.status_sync.error_message})` : ''}.`
            );
        }
        preparedCapture = verifyPreparedWipCapture(repoRoot, preparedCapture);
        const finalWorkspaceViolations = validateWorkspaceMatchesPreparedCapture(
            repoRoot,
            trackedChanges,
            preparedCapture
        );
        if (finalWorkspaceViolations.length > 0) {
            throw new Error(`WIP changed before suspension: ${finalWorkspaceViolations.join(' ')}`);
        }

        suspensionStarted = true;
        suspendPreparedWip(repoRoot, trackedChanges, preparedCapture);
        const suspensionViolations = validatePreparedWipSuspended(repoRoot, preparedCapture);
        if (suspensionViolations.length > 0) {
            throw new Error(suspensionViolations.join(' '));
        }
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
            wip_manifest_sha256: createHash('sha256').update(preparedCapture.manifestSnapshot.content).digest('hex'),
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
            'BLOCKED',
            'Full-suite timeout repair task materialized and parent WIP suspended.',
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

        return {
            status: 'MATERIALIZED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: normalizePath(manifestPath),
            split_required_artifact_path: latchResult.artifact_path,
            violations,
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                status: 'MATERIALIZED',
                action: 'Continue parent routing through the repair child.',
                reason: 'Full-suite timeout repair task materialized and parent WIP suspended.',
                detailsPath: artifactPath,
                detailsHint: 'Parent routing should continue via the repair child.',
                legacyLines: [
                    'FULL_SUITE_REPAIR_TASK_MATERIALIZED',
                    `TaskId: ${params.taskId}`,
                    `ChildTaskId: ${proposal.suggested_task_id}`,
                    `ArtifactPath: ${normalizePath(artifactPath)}`,
                    `WipManifestPath: ${normalizePath(manifestPath)}`,
                    `SplitRequiredArtifactPath: ${latchResult.artifact_path}`,
                    `NextStep: run ${buildNextStepCommand(repoRoot, params.taskId) || 'next-step'}; parent routing should continue via the repair child.`
                ]
            })
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`repair materialization transaction failed: ${message}`);
        const rollbackViolations: string[] = [];
        if (suspensionStarted) {
            rollbackViolations.push(
                ...rollbackPreparedWipSuspension(repoRoot, trackedChanges, preparedCapture)
            );
        }
        rollbackViolations.push(...restoreTaskQueueTransactionSnapshot(repoRoot, taskSnapshot));
        rollbackViolations.push(
            ...restoreOptionalControlPlaneFile(
                repoRoot,
                splitRequiredSnapshot,
                'split-required transaction snapshot'
            )
        );
        rollbackViolations.push(
            ...restoreOptionalControlPlaneFile(
                repoRoot,
                materializationArtifactSnapshot,
                'repair materialization artifact transaction snapshot'
            )
        );
        if (latchResult?.status_sync.outcome === 'updated') {
            const restoredStatus = readTaskStatusFromControlPlaneSnapshot(taskSnapshot, params.taskId);
            if (!restoredStatus) {
                rollbackViolations.push(
                    `failed to record compensating parent status event: original status for ${params.taskId} is unavailable.`
                );
            } else {
                try {
                    appendMandatoryTaskEvent(
                        joinOrchestratorPath(repoRoot, ''),
                        params.taskId,
                        'STATUS_CHANGED',
                        'INFO',
                        `Task status changed: SPLIT_REQUIRED -> ${restoredStatus}.`,
                        {
                            previous_status: 'SPLIT_REQUIRED',
                            new_status: restoredStatus,
                            reason: 'full_suite_repair_materialization_rollback',
                            repair_child_task_id: proposal.suggested_task_id
                        },
                        { actor: 'orchestrator' }
                    );
                } catch (eventError: unknown) {
                    const eventMessage = eventError instanceof Error ? eventError.message : String(eventError);
                    rollbackViolations.push(
                        `failed to record compensating parent status event: ${eventMessage}`
                    );
                }
            }
        }
        let retainedManifestPath: string | null = wipCapture.manifestPath;
        if (rollbackViolations.length === 0) {
            const cleanupViolations = removePreparedWipCapture(repoRoot, wipCapture.captureRoot);
            rollbackViolations.push(...cleanupViolations);
            if (cleanupViolations.length === 0) {
                retainedManifestPath = null;
            }
        }
        violations.push(...rollbackViolations);
        try {
            appendMandatoryTaskEvent(
                joinOrchestratorPath(repoRoot, ''),
                params.taskId,
                'FULL_SUITE_REPAIR_TASK_MATERIALIZATION_ROLLED_BACK',
                rollbackViolations.length === 0 ? 'BLOCKED' : 'FAIL',
                rollbackViolations.length === 0
                    ? 'Full-suite repair task materialization rolled back transactionally.'
                    : 'Full-suite repair task materialization rollback is incomplete.',
                {
                    child_task_id: proposal.suggested_task_id,
                    wip_manifest_path: retainedManifestPath
                        ? normalizePath(retainedManifestPath)
                        : null,
                    task_queue: queueResult,
                    split_required_artifact_path: splitRequiredSnapshot.existed
                        ? normalizePath(splitRequiredSnapshot.path)
                        : null,
                    rollback_violations: rollbackViolations,
                    failure: message
                },
                { actor: 'orchestrator' }
            );
        } catch (eventError: unknown) {
            const eventMessage = eventError instanceof Error ? eventError.message : String(eventError);
            violations.push(`failed to record repair materialization rollback event: ${eventMessage}`);
        }
        return buildBlockedMaterializationResult({
            repoRoot,
            taskId: params.taskId,
            proposal,
            artifactPath,
            preflightPath,
            fullSuiteArtifactPath,
            timestampUtc: wipCapture.timestampUtc,
            queueResult,
            splitRequiredArtifactPath: splitRequiredSnapshot.existed
                ? normalizePath(splitRequiredSnapshot.path)
                : null,
            splitRequiredArtifactSha256: splitRequiredSnapshot.content
                ? createHash('sha256').update(splitRequiredSnapshot.content).digest('hex')
                : null,
            retainedManifestPath,
            priorMaterializationArtifactSnapshot: materializationArtifactSnapshot,
            violations
        });
    }
}

function buildMaterializationLockBlockedResult(params: {
    repoRoot: string;
    taskId: string;
    artifactPath: string;
    violation: string;
    action: string;
}): FullSuiteRepairTaskMaterializationResult {
    return {
        status: 'BLOCKED',
        task_id: params.taskId,
        child_task_id: null,
        artifact_path: normalizePath(params.artifactPath),
        wip_manifest_path: null,
        split_required_artifact_path: null,
        violations: [params.violation],
        output_lines: formatFullSuiteRepairOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            status: 'BLOCKED',
            action: params.action,
            reason: params.violation,
            detailsPath: params.artifactPath,
            legacyLines: [
                'FULL_SUITE_REPAIR_TASK_BLOCKED',
                `TaskId: ${params.taskId}`,
                `ArtifactPath: ${normalizePath(params.artifactPath)}`,
                `Violation: ${params.violation}`
            ]
        })
    };
}

export function materializeFullSuiteRepairTask(
    params: MaterializeFullSuiteRepairTaskParams
): FullSuiteRepairTaskMaterializationResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    let transactionStarted = false;
    let artifactPath = resolveFullSuiteRepairTaskArtifactPath(
        joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews')),
        params.taskId
    );
    try {
        const reviewsRoot = params.reviewsRoot
            ? resolveInputPathInsideRepo(repoRoot, params.reviewsRoot, 'ReviewsRoot')
            : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
        artifactPath = resolveFullSuiteRepairTaskArtifactPath(reviewsRoot, params.taskId);
        const lockRoot = joinOrchestratorPath(
            repoRoot,
            path.join('runtime', 'locks', 'full-suite-repair-task')
        );
        ensureContainedDirectoryPath(repoRoot, lockRoot, 'full-suite repair materialization lock root');
        const lockKey = createHash('sha256').update(String(params.taskId || '')).digest('hex').slice(0, 32);
        const lockPath = path.join(lockRoot, `${lockKey}.lock`);
        const containmentViolations = validatePhysicalRepoContainment(
            repoRoot,
            lockPath,
            'full-suite repair materialization lock path'
        );
        if (containmentViolations.length > 0) {
            throw new Error(containmentViolations.join(' '));
        }
        return withFilesystemLock(lockPath, {
            ownerLabel: `full-suite-repair-task-materialization:${String(params.taskId || '').trim() || 'unknown'}`,
            timeoutMs: 5000
        }, () => {
            transactionStarted = true;
            return materializeFullSuiteRepairTaskUnlocked(params);
        }).result;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const violation = transactionStarted
            ? `materialization execution failed unexpectedly: ${message}`
            : `materialization lock acquisition failed: ${message}`;
        return buildMaterializationLockBlockedResult({
            repoRoot,
            taskId: params.taskId,
            artifactPath,
            violation,
            action: transactionStarted
                ? 'Resolve the unexpected materialization failure before retrying.'
                : 'Resolve materialization lock failure before retrying.'
        });
    }
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

function decodeGitExtendedHeaderPath(rawValue: string): string {
    if (!rawValue.startsWith('"')) {
        return rawValue;
    }
    if (!rawValue.endsWith('"') || rawValue.length < 2) {
        throw new Error(`malformed quoted Git path: ${rawValue}`);
    }
    const bytes: number[] = [];
    const content = rawValue.slice(1, -1);
    for (let index = 0; index < content.length;) {
        const character = content[index];
        if (character !== '\\') {
            const codePoint = content.codePointAt(index);
            if (codePoint === undefined) {
                break;
            }
            bytes.push(...Buffer.from(String.fromCodePoint(codePoint), 'utf8'));
            index += codePoint > 0xFFFF ? 2 : 1;
            continue;
        }
        index += 1;
        if (index >= content.length) {
            throw new Error(`malformed Git path escape: ${rawValue}`);
        }
        const escaped = content[index];
        if (/[0-7]/u.test(escaped)) {
            let octal = escaped;
            index += 1;
            while (index < content.length && octal.length < 3 && /[0-7]/u.test(content[index])) {
                octal += content[index];
                index += 1;
            }
            const octalByte = Number.parseInt(octal, 8);
            if (octalByte > 0xFF) {
                throw new Error(`Git path octal escape exceeds one byte: ${rawValue}`);
            }
            bytes.push(octalByte);
            continue;
        }
        const simpleEscapes: Record<string, number> = {
            a: 0x07,
            b: 0x08,
            t: 0x09,
            n: 0x0A,
            v: 0x0B,
            f: 0x0C,
            r: 0x0D,
            '"': 0x22,
            '\\': 0x5C
        };
        if (!(escaped in simpleEscapes)) {
            throw new Error(`unsupported Git path escape \\${escaped}: ${rawValue}`);
        }
        bytes.push(simpleEscapes[escaped]);
        index += 1;
    }
    const rawBytes = Buffer.from(bytes);
    const decoded = rawBytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(rawBytes)) {
        throw new Error(`Git path is not valid UTF-8: ${rawValue}`);
    }
    return decoded;
}

function parsePatchExtendedPathRecords(repoRoot: string, patchContent: Buffer, label: string): {
    records: PatchPathRecord[];
    violations: string[];
} {
    const records: PatchPathRecord[] = [];
    const violations: string[] = [];
    let pending: { kind: 'rename' | 'copy'; path: string } | null = null;
    const lines = patchContent.toString('utf8').replace(/\r\n/gu, '\n').split('\n');
    for (const line of lines) {
        const fromMatch = /^(rename|copy) from (.+)$/u.exec(line);
        if (fromMatch) {
            if (pending) {
                violations.push(`${label} has an incomplete ${pending.kind} path pair.`);
            }
            try {
                pending = {
                    kind: fromMatch[1] as 'rename' | 'copy',
                    path: normalizeGitPath(decodeGitExtendedHeaderPath(fromMatch[2]))
                };
            } catch (error: unknown) {
                violations.push(error instanceof Error ? error.message : String(error));
                pending = null;
            }
            continue;
        }
        const toMatch = /^(rename|copy) to (.+)$/u.exec(line);
        if (!toMatch) {
            continue;
        }
        const kind = toMatch[1] as 'rename' | 'copy';
        if (!pending || pending.kind !== kind) {
            violations.push(`${label} has an unmatched ${kind} destination path.`);
            pending = null;
            continue;
        }
        try {
            const destinationPath = normalizeGitPath(decodeGitExtendedHeaderPath(toMatch[2]));
            const pair = [pending.path, destinationPath];
            pair.forEach((entry, index) => {
                violations.push(...validateManifestRelativePath(
                    repoRoot,
                    entry,
                    `${label} ${kind} path ${records.length + 1}.${index + 1}`
                ));
            });
            records.push({ paths: pair });
        } catch (error: unknown) {
            violations.push(error instanceof Error ? error.message : String(error));
        }
        pending = null;
    }
    if (pending) {
        violations.push(`${label} has an incomplete ${pending.kind} path pair.`);
    }
    return { records, violations };
}

function parsePatchNumstatRecords(
    repoRoot: string,
    patch: CapturedPatchEvidence,
    patchContent: Buffer | null,
    label: string
): {
    records: PatchPathRecord[];
    violations: string[];
} {
    if (!hasPatchContent(patch)) {
        return { records: [], violations: [] };
    }
    if (!patchContent) {
        return { records: [], violations: [`${label} validated content snapshot is unavailable.`] };
    }
    const args = ['apply', '--numstat', '-z', '-'];
    const result = runGitStatus(repoRoot, args, patchContent);
    if (result.status !== 0) {
        return { records: [], violations: [gitFailureMessage(args, result)] };
    }
    const tokens = result.stdout.split('\0');
    if (tokens.at(-1) === '') {
        tokens.pop();
    }
    const records: PatchPathRecord[] = [];
    const violations: string[] = [];
    for (let index = 0; index < tokens.length;) {
        const header = tokens[index++];
        const firstTab = header.indexOf('\t');
        const secondTab = firstTab >= 0 ? header.indexOf('\t', firstTab + 1) : -1;
        if (firstTab <= 0 || secondTab <= firstTab + 1) {
            violations.push(`${label} has malformed git apply --numstat output.`);
            break;
        }
        const additions = header.slice(0, firstTab);
        const deletions = header.slice(firstTab + 1, secondTab);
        if (!/^(?:[0-9]+|-)$/u.test(additions) || !/^(?:[0-9]+|-)$/u.test(deletions)) {
            violations.push(`${label} has invalid numstat counters.`);
            break;
        }
        const inlinePath = header.slice(secondTab + 1);
        const rawPaths = inlinePath
            ? [inlinePath]
            : [tokens[index++] || '', tokens[index++] || ''];
        if (rawPaths.some((entry) => !entry)) {
            violations.push(`${label} has incomplete rename/copy path evidence.`);
            break;
        }
        const normalizedPaths = rawPaths.map(normalizeGitPath);
        normalizedPaths.forEach((entry, pathIndex) => {
            violations.push(...validateManifestRelativePath(
                repoRoot,
                entry,
                `${label} changed path ${records.length + 1}.${pathIndex + 1}`
            ));
        });
        records.push({ paths: normalizedPaths });
    }
    if (records.length === 0 && violations.length === 0) {
        violations.push(`${label} declares content but contains no changed paths.`);
    }
    const extendedRecords = parsePatchExtendedPathRecords(repoRoot, patchContent, label);
    records.push(...extendedRecords.records);
    violations.push(...extendedRecords.violations);
    return { records, violations };
}

function validateManifestPatchBindings(
    repoRoot: string,
    manifest: RepairWipManifest,
    patchSnapshots: RestorePatchSnapshots
): {
    historyPaths: string[];
    violations: string[];
} {
    const historyPaths = new Set<string>();
    const violations: string[] = [];
    for (const [label, patch, flag] of [
        ['staged patch', manifest.patches.staged, 'staged'],
        ['unstaged patch', manifest.patches.unstaged, 'unstaged']
    ] as const) {
        const parsed = parsePatchNumstatRecords(repoRoot, patch, patchSnapshots[flag], label);
        violations.push(...parsed.violations);
        const manifestPaths = new Set(
            manifest.tracked_files
                .filter((entry) => entry[flag])
                .map((entry) => normalizeGitPath(entry.path))
        );
        if (hasPatchContent(patch) && manifestPaths.size === 0) {
            violations.push(`WIP manifest ${label} has content but no bound tracked_files entries.`);
        }
        if (!hasPatchContent(patch) && manifestPaths.size > 0) {
            violations.push(`WIP manifest ${label} is empty but tracked_files claims ${flag} changes.`);
        }
        for (const record of parsed.records) {
            record.paths.forEach((entry) => historyPaths.add(entry));
            if (!record.paths.every((entry) => manifestPaths.has(entry))) {
                violations.push(`${label} changed paths are not bound by tracked_files: ${record.paths.join(' -> ')}`);
            }
        }
        for (const manifestPath of manifestPaths) {
            if (!parsed.records.some((record) => record.paths.includes(manifestPath))) {
                violations.push(`WIP manifest tracked_files path is absent from ${label}: ${manifestPath}`);
            }
            historyPaths.add(manifestPath);
        }
    }
    return {
        historyPaths: [...historyPaths].sort(),
        violations
    };
}

function validateDescendantRestoreHead(repoRoot: string, manifest: RepairWipManifest, trackedHistoryPaths: string[]): string[] {
    const currentHead = getHeadCommit(repoRoot);
    if (!manifest.base_commit) {
        return ['WIP manifest base_commit is missing.'];
    }
    if (currentHead === manifest.base_commit) {
        return [];
    }
    const violations: string[] = [];
    const ancestryArgs = ['merge-base', '--is-ancestor', manifest.base_commit, currentHead];
    const ancestry = runGitStatus(repoRoot, ancestryArgs);
    if (ancestry.status === 1) {
        return [`manifest base commit is not an ancestor of current HEAD: manifest=${manifest.base_commit}; current=${currentHead}`];
    }
    if (ancestry.status !== 0) {
        return [gitFailureMessage(ancestryArgs, ancestry)];
    }
    for (const trackedPath of trackedHistoryPaths) {
        const historyArgs = [
            '--literal-pathspecs',
            'log',
            '--full-history',
            '-m',
            '--no-renames',
            '--format=',
            '--name-only',
            '-z',
            `${manifest.base_commit}..${currentHead}`,
            '--',
            normalizeGitPath(trackedPath)
        ];
        const history = runGitStatus(repoRoot, historyArgs);
        if (history.status !== 0) {
            violations.push(gitFailureMessage(historyArgs, history));
        } else if (splitNulList(history.stdout).length > 0) {
            violations.push(`repair child commit overlaps suspended WIP path: ${trackedPath}`);
        }
    }
    return violations;
}

function inspectRestoreMutationState(repoRoot: string, manifest: RepairWipManifest): RestoreMutationInspection {
    const referenceValidation = validateManifestFileReferences(repoRoot, manifest);
    const patchBindings = referenceValidation.violations.length === 0
        ? validateManifestPatchBindings(repoRoot, manifest, referenceValidation.patchSnapshots)
        : {
            historyPaths: manifest.tracked_files.map((entry) => normalizeGitPath(entry.path)),
            violations: []
        };
    const violations = [
        ...referenceValidation.violations,
        ...patchBindings.violations,
        ...validateDescendantRestoreHead(repoRoot, manifest, patchBindings.historyPaths),
        ...ensureCleanTrackedWorkspace(repoRoot)
    ];
    for (const entry of manifest.untracked_files) {
        const targetPath = resolveRepoPath(repoRoot, entry.path);
        violations.push(...validatePhysicalRepoContainment(repoRoot, targetPath, `untracked restore target ${entry.path}`));
        if (fs.existsSync(targetPath)) {
            violations.push(`untracked restore target already exists: ${entry.path}`);
        }
    }
    return {
        violations,
        patchSnapshots: referenceValidation.patchSnapshots
    };
}

function scrubAndRemoveRestoredUntrackedFile(
    repoRoot: string,
    entry: CapturedUntrackedFileEvidence
): void {
    const targetPath = resolveRepoPath(repoRoot, entry.path);
    const containmentViolations = validatePhysicalRepoContainment(
        repoRoot,
        targetPath,
        `rollback target ${entry.path}`
    );
    if (containmentViolations.length > 0) {
        throw new Error(`rollback refused unsafe untracked restore target ${entry.path}: ${containmentViolations.join(' ')}`);
    }
    let identityBeforeOpen: fs.Stats;
    try {
        identityBeforeOpen = fs.lstatSync(targetPath);
    } catch (error: unknown) {
        const code = error != null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : '';
        if (code === 'ENOENT') {
            return;
        }
        throw error;
    }
    if (!identityBeforeOpen.isFile()) {
        throw new Error(`rollback refused to remove changed untracked restore target: ${entry.path}`);
    }

    const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
    let descriptor: number | null = null;
    try {
        descriptor = fs.openSync(targetPath, fs.constants.O_RDWR | noFollowFlag);
        const openedIdentity = fs.fstatSync(descriptor);
        if (!openedIdentity.isFile() || !sameFileIdentity(identityBeforeOpen, openedIdentity)) {
            throw new Error(`rollback target identity changed while opening: ${entry.path}`);
        }
        const content = fs.readFileSync(descriptor);
        const identityAfterRead = fs.fstatSync(descriptor);
        if (!sameFileSnapshot(openedIdentity, identityAfterRead)
            || (identityAfterRead.mode & 0o777) !== entry.mode
            || content.byteLength !== entry.bytes
            || createHash('sha256').update(content).digest('hex') !== entry.sha256) {
            throw new Error(`rollback refused to remove changed untracked restore target: ${entry.path}`);
        }

        // Scrub through the authenticated descriptor before unlinking the worktree name.
        // If another hard link appeared after restore validation, no link may retain WIP bytes.
        fs.ftruncateSync(descriptor, 0);
        fs.fsyncSync(descriptor);

        const finalContainmentViolations = validatePhysicalRepoContainment(
            repoRoot,
            targetPath,
            `rollback target ${entry.path}`
        );
        if (finalContainmentViolations.length > 0) {
            throw new Error(
                `rollback refused unsafe untracked restore target ${entry.path}: ${finalContainmentViolations.join(' ')}`
            );
        }
        const finalPathIdentity = fs.lstatSync(targetPath);
        if (!sameFileIdentity(identityAfterRead, finalPathIdentity)) {
            throw new Error(`rollback target identity changed before removal: ${entry.path}`);
        }
        fs.unlinkSync(targetPath);
    } finally {
        if (descriptor !== null) {
            fs.closeSync(descriptor);
        }
    }
}

function rollbackFullSuiteRepairRestore(params: {
    repoRoot: string;
    manifest: RepairWipManifest;
    patchSnapshots: RestorePatchSnapshots;
    stagedApplied: boolean;
    unstagedApplied: boolean;
    createdUntrackedFiles: CapturedUntrackedFileEvidence[];
}): string[] {
    const violations: string[] = [];
    for (const entry of [...params.createdUntrackedFiles].reverse()) {
        try {
            scrubAndRemoveRestoredUntrackedFile(params.repoRoot, entry);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`failed to roll back untracked restore target ${entry.path}: ${message}`);
        }
    }
    for (const [applied, patch, kind, label, indexArgs] of [
        [params.unstagedApplied, params.manifest.patches.unstaged, 'unstaged', 'unstaged', []],
        [params.stagedApplied, params.manifest.patches.staged, 'staged', 'staged', ['--index']]
    ] as const) {
        if (!applied || !hasPatchContent(patch)) {
            continue;
        }
        try {
            const patchContent = params.patchSnapshots[kind];
            if (!patchContent) {
                violations.push(`failed to roll back ${label} WIP patch: validated content snapshot is unavailable.`);
                continue;
            }
            const args = ['apply', '--reverse', ...indexArgs, '-'];
            const result = runGitStatus(params.repoRoot, args, patchContent);
            if (result.status !== 0) {
                violations.push(`failed to roll back ${label} WIP patch: ${gitFailureMessage(args, result)}`);
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`failed to apply ${label} WIP rollback snapshot: ${message}`);
        }
    }
    return violations;
}

function validateManifestFileReferences(repoRoot: string, manifest: RepairWipManifest): {
    violations: string[];
    patchSnapshots: RestorePatchSnapshots;
} {
    const violations: string[] = [];
    const patchSnapshots: RestorePatchSnapshots = {
        staged: null,
        unstaged: null
    };
    if (!isPlainRecord(manifest.patches)
        || !isPlainRecord(manifest.patches.staged)
        || !isPlainRecord(manifest.patches.unstaged)) {
        return {
            violations: ['WIP manifest patch references are missing or invalid.'],
            patchSnapshots
        };
    }
    const validateArtifactHash = (params: {
        label: string;
        artifactPath: string;
        expectedSha256: string;
        expectedBytes?: number;
        expectedEmpty?: boolean;
        expectedMode?: number;
    }): Buffer | null => {
        const initialViolationCount = violations.length;
        const containmentViolations = validatePhysicalRepoContainment(repoRoot, params.artifactPath, params.label);
        if (containmentViolations.length > 0) {
            violations.push(...containmentViolations);
            return null;
        }
        if (!params.expectedSha256) {
            violations.push(`${params.label} sha256 is missing.`);
            return null;
        }
        if (!fs.existsSync(params.artifactPath)) {
            violations.push(`${params.label} artifact is missing: ${normalizePath(params.artifactPath)}`);
            return null;
        }
        let artifactSnapshot: CaptureFileSnapshot;
        try {
            artifactSnapshot = readImmutableRegularFileSnapshot({
                repoRoot,
                filePath: params.artifactPath,
                label: `${params.label} artifact`
            });
            if (params.expectedMode !== undefined
                && (artifactSnapshot.identity.mode & 0o777) !== params.expectedMode) {
                violations.push(
                    `${params.label} mode mismatch: expected=${params.expectedMode.toString(8)}; actual=${(artifactSnapshot.identity.mode & 0o777).toString(8)}`
                );
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`${params.label} artifact cannot be read: ${message}`);
            return null;
        }
        const artifactBytes = artifactSnapshot.content;
        if (params.expectedBytes !== undefined && artifactBytes.byteLength !== params.expectedBytes) {
            violations.push(`${params.label} byte count mismatch: expected=${params.expectedBytes}; actual=${artifactBytes.byteLength}`);
        }
        if (params.expectedEmpty !== undefined && params.expectedEmpty !== (artifactBytes.byteLength === 0)) {
            violations.push(`${params.label} empty flag does not match artifact size.`);
        }
        const actualSha256 = createHash('sha256').update(artifactBytes).digest('hex');
        if (actualSha256 !== params.expectedSha256) {
            violations.push(`${params.label} sha256 mismatch: expected=${params.expectedSha256}; actual=${actualSha256}`);
        }
        return violations.length === initialViolationCount ? artifactBytes : null;
    };
    for (const [label, artifactPathValue, expectedSha256] of [
        ['preflight', manifest.preflight_path, manifest.preflight_sha256],
        ['full-suite validation', manifest.full_suite_artifact_path, manifest.full_suite_artifact_sha256]
    ] as const) {
        try {
            const artifactPath = resolveInputPathInsideRepo(repoRoot, artifactPathValue, `${label} artifact`);
            validateArtifactHash({
                label: `${label} artifact`,
                artifactPath,
                expectedSha256
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(message);
        }
    }
    for (const [kind, label, patch] of [
        ['staged', 'staged patch', manifest.patches.staged],
        ['unstaged', 'unstaged patch', manifest.patches.unstaged]
    ] as const) {
        try {
            const patchPath = resolveInputPathInsideRepo(repoRoot, patch.path, label);
            patchSnapshots[kind] = validateArtifactHash({
                label,
                artifactPath: patchPath,
                expectedSha256: patch.sha256,
                expectedBytes: patch.bytes,
                expectedEmpty: patch.empty
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(message);
        }
    }
    for (const entry of manifest.untracked_files || []) {
        try {
            const artifactPath = resolveInputPathInsideRepo(repoRoot, entry.artifact_path, `untracked artifact ${entry.path}`);
            validateArtifactHash({
                label: `untracked artifact ${entry.path}`,
                artifactPath,
                expectedSha256: entry.sha256,
                expectedBytes: entry.bytes,
                expectedMode: entry.mode
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(message);
        }
    }
    return { violations, patchSnapshots };
}

function isParentResumeStatus(status: string | null): boolean {
    return status === 'SPLIT_REQUIRED' || status === 'DECOMPOSED' || status === 'IN_PROGRESS';
}

function resumeParentTaskAfterWipRestore(repoRoot: string, taskId: string): ParentResumeStatusResult {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
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

function rollbackParentTaskStatusAfterWipRestore(
    repoRoot: string,
    taskId: string,
    parentResume: ParentResumeStatusResult
): string[] {
    if (parentResume.outcome !== 'updated' || !parentResume.previous_status) {
        return [];
    }
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    try {
        return withTaskQueueStatusSyncLock<string[]>(
            taskPath,
            (message) => [`failed to roll back parent task status: ${message}`],
            () => {
                if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
                    return [`failed to roll back parent task status: TASK.md is missing at ${normalizePath(taskPath)}.`];
                }
                const original = fs.readFileSync(taskPath, 'utf8');
                const newline = original.includes('\r\n') ? '\r\n' : '\n';
                const lines = original.split(/\r?\n/);
                const row = parseCanonicalActiveTaskQueue(original).rows.find((candidate) => candidate.taskId === taskId);
                if (!row) {
                    return [`failed to roll back parent task status: task ${taskId} is missing.`];
                }
                const currentStatus = readTaskQueueStatusToken(row.status);
                if (currentStatus !== 'IN_PROGRESS') {
                    return [
                        `failed to roll back parent task status: expected IN_PROGRESS after restore sync; found ${currentStatus || 'unknown'}.`
                    ];
                }
                const previousStatus = String(parentResume.previous_status || '');
                if (!isParentResumeStatus(previousStatus) || previousStatus === 'IN_PROGRESS') {
                    return [`failed to roll back parent task status: invalid previous status ${previousStatus}.`];
                }
                const previousStatusCell = formatTaskQueueStatusCell(row.cells[1].raw, previousStatus);
                const restoredLine = replaceTaskMdTableCell(row.rawLine, 1, previousStatusCell);
                if (!restoredLine) {
                    return ['failed to roll back parent task status: TASK.md status cell replacement failed.'];
                }
                lines[row.lineIndex] = restoredLine;
                fs.writeFileSync(taskPath, formatActiveTaskQueueTable(lines.join(newline)), 'utf8');
                return [];
            }
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`failed to roll back parent task status: ${message}`];
    }
}

function validateParentCanResumeAfterWipRestore(repoRoot: string, taskId: string): string[] {
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
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
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
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

function buildRestoreTransactionBlockedResult(params: {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    restoredFiles: Set<string>;
    violations: string[];
    rollbackIncomplete: boolean;
}): FullSuiteRepairWipRestoreResult {
    return {
        status: 'BLOCKED',
        manifest_path: normalizePath(params.manifestPath),
        restored_files: params.rollbackIncomplete ? [...params.restoredFiles].sort() : [],
        violations: params.violations,
        output_lines: formatFullSuiteRepairOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            gate: 'full-suite-repair-wip-restore',
            status: 'BLOCKED',
            action: 'Fix restore transaction blockers before retrying WIP restore.',
            reason: params.violations.join(' '),
            detailsPath: params.manifestPath,
            legacyLines: [
                'FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED',
                ...params.violations.map((violation) => `Violation: ${violation}`)
            ]
        })
    };
}

function restoreFullSuiteRepairWipUnlocked(params: RestoreFullSuiteRepairWipParams): FullSuiteRepairWipRestoreResult {
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
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                gate: 'full-suite-repair-wip-restore',
                status: 'BLOCKED',
                action: 'Fix the restore input paths before retrying WIP restore.',
                reason: message,
                detailsPath: params.manifestPath ? path.resolve(repoRoot, String(params.manifestPath)) : null,
                legacyLines: ['FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED', `Violation: ${message}`]
            })
        };
    }
    const taskId = String(params.taskId || '').trim();
    const violations: string[] = [];
    let expectedManifestSha256 = '';
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
            expectedManifestSha256 = String(materializationEvidence.wip_manifest_sha256 || '').trim();
        }
    }
    let manifestValue: unknown = null;
    try {
        const manifestBytes = readImmutableRegularFileSnapshot({
            repoRoot,
            filePath: manifestPath,
            label: 'WIP manifest restore snapshot'
        }).content;
        const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
        if (!expectedManifestSha256 || manifestSha256 !== expectedManifestSha256) {
            violations.push(
                `WIP manifest changed after materialization validation: expected=${expectedManifestSha256 || 'missing'}; actual=${manifestSha256}.`
            );
        } else {
            manifestValue = JSON.parse(manifestBytes.toString('utf8')) as unknown;
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`WIP manifest snapshot could not be read: ${message}`);
    }
    const parsedManifest = parseRepairWipManifest(repoRoot, manifestPath, manifestValue);
    const manifest = parsedManifest.manifest;
    violations.push(...parsedManifest.violations);
    if (manifest) {
        if (manifest.task_id !== taskId) {
            violations.push(`WIP manifest task_id mismatch: expected=${taskId}; actual=${manifest.task_id}.`);
        }
        violations.push(...validateRepairChildDone(repoRoot, String(manifest.child_task_id || '')));
        violations.push(...validateParentCanResumeAfterWipRestore(repoRoot, String(manifest.task_id || '')));
        violations.push(...inspectRestoreMutationState(repoRoot, manifest).violations);
    }
    if (violations.length > 0 || !manifest) {
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            violations,
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId,
                gate: 'full-suite-repair-wip-restore',
                status: 'BLOCKED',
                action: 'Resolve WIP restore blockers before retrying restore.',
                reason: violations.join(' '),
                detailsPath: manifestPath,
                legacyLines: ['FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED', ...violations.map((violation) => `Violation: ${violation}`)]
            })
        };
    }
    if (params.dryRun) {
        return {
            status: 'DRY_RUN_OK',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            violations: [],
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId,
                gate: 'full-suite-repair-wip-restore',
                status: 'DRY_RUN_OK',
                action: 'Run restore without --dry-run when ready to restore parent WIP.',
                reason: 'Dry run verified the WIP manifest can be restored.',
                command: buildRestoreFullSuiteRepairWipCommand({
                    repoRoot,
                    taskId,
                    fullSuiteArtifactPath,
                    manifestPath,
                    childTaskId: manifest.child_task_id
                }),
                detailsPath: manifestPath,
                legacyLines: [
                    'FULL_SUITE_REPAIR_WIP_RESTORE_DRY_RUN_OK',
                    `ManifestPath: ${normalizePath(manifestPath)}`,
                    `TrackedFiles: ${manifest.tracked_files.length}`,
                    `UntrackedFiles: ${manifest.untracked_files.length}`
                ]
            })
        };
    }

    const mutationInspection = inspectRestoreMutationState(repoRoot, manifest);
    if (mutationInspection.violations.length > 0) {
        return {
            status: 'BLOCKED',
            manifest_path: normalizePath(manifestPath),
            restored_files: [],
            violations: mutationInspection.violations,
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId,
                gate: 'full-suite-repair-wip-restore',
                status: 'BLOCKED',
                action: 'Resolve WIP restore blockers before retrying restore.',
                reason: mutationInspection.violations.join(' '),
                detailsPath: manifestPath,
                legacyLines: [
                    'FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED',
                    ...mutationInspection.violations.map((violation) => `Violation: ${violation}`)
                ]
            })
        };
    }
    const patchSnapshots = mutationInspection.patchSnapshots;

    const restoredFiles = new Set<string>();
    const createdUntrackedFiles: CapturedUntrackedFileEvidence[] = [];
    let stagedApplied = false;
    let unstagedApplied = false;
    try {
        if (hasPatchContent(manifest.patches.staged)) {
            const stagedPatch = patchSnapshots.staged;
            if (!stagedPatch) {
                throw new Error('staged patch validated content snapshot is unavailable.');
            }
            runGitWithInput(repoRoot, ['apply', '--check', '--index', '-'], stagedPatch);
            runGitWithInput(repoRoot, ['apply', '--index', '-'], stagedPatch);
            stagedApplied = true;
            for (const entry of manifest.tracked_files.filter((file) => file.staged)) {
                restoredFiles.add(entry.path);
            }
        }
        if (hasPatchContent(manifest.patches.unstaged)) {
            const unstagedPatch = patchSnapshots.unstaged;
            if (!unstagedPatch) {
                throw new Error('unstaged patch validated content snapshot is unavailable.');
            }
            runGitWithInput(repoRoot, ['apply', '--check', '-'], unstagedPatch);
            runGitWithInput(repoRoot, ['apply', '-'], unstagedPatch);
            unstagedApplied = true;
            for (const entry of manifest.tracked_files.filter((file) => file.unstaged)) {
                restoredFiles.add(entry.path);
            }
        }
        for (const entry of manifest.untracked_files) {
            restoreContainedUntrackedFile({ repoRoot, entry });
            createdUntrackedFiles.push(entry);
            restoredFiles.add(entry.path);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const rollbackViolations = rollbackFullSuiteRepairRestore({
            repoRoot,
            manifest,
            patchSnapshots,
            stagedApplied,
            unstagedApplied,
            createdUntrackedFiles
        });
        const restoreViolations = [`restore transaction failed: ${message}`, ...rollbackViolations];
        return buildRestoreTransactionBlockedResult({
            repoRoot,
            taskId,
            manifestPath,
            restoredFiles,
            violations: restoreViolations,
            rollbackIncomplete: rollbackViolations.length > 0
        });
    }
    let parentResume: ParentResumeStatusResult;
    try {
        parentResume = resumeParentTaskAfterWipRestore(repoRoot, manifest.task_id);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const rollbackViolations = rollbackFullSuiteRepairRestore({
            repoRoot,
            manifest,
            patchSnapshots,
            stagedApplied,
            unstagedApplied,
            createdUntrackedFiles
        });
        return buildRestoreTransactionBlockedResult({
            repoRoot,
            taskId,
            manifestPath,
            restoredFiles,
            violations: [`parent status sync failed: ${message}`, ...rollbackViolations],
            rollbackIncomplete: rollbackViolations.length > 0
        });
    }
    if (parentResume.outcome !== 'updated' && parentResume.outcome !== 'already_synced') {
        const rollbackViolations = rollbackFullSuiteRepairRestore({
            repoRoot,
            manifest,
            patchSnapshots,
            stagedApplied,
            unstagedApplied,
            createdUntrackedFiles
        });
        const restoreViolations = [
            `parent status sync failed: ${parentResume.outcome}${parentResume.error_message ? ` (${parentResume.error_message})` : ''}`,
            ...rollbackViolations
        ];
        try {
            appendMandatoryTaskEvent(
                joinOrchestratorPath(repoRoot, ''),
                manifest.task_id,
                'FULL_SUITE_REPAIR_WIP_RESTORE_ROLLED_BACK',
                'BLOCKED',
                'Full-suite repair parent WIP restore rolled back after parent status sync failure.',
                {
                    manifest_path: normalizePath(manifestPath),
                    child_task_id: manifest.child_task_id,
                    restored_files: [...restoredFiles].sort(),
                    parent_status_sync: parentResume,
                    rollback_violations: rollbackViolations
                },
                { actor: 'orchestrator' }
            );
        } catch (eventError: unknown) {
            const eventMessage = eventError instanceof Error ? eventError.message : String(eventError);
            restoreViolations.push(`failed to record rolled-back restore event: ${eventMessage}`);
        }
        return buildRestoreTransactionBlockedResult({
            repoRoot,
            taskId,
            manifestPath,
            restoredFiles,
            violations: restoreViolations,
            rollbackIncomplete: rollbackViolations.length > 0
        });
    }
    try {
        appendMandatoryTaskEvent(
            joinOrchestratorPath(repoRoot, ''),
            manifest.task_id,
            'FULL_SUITE_REPAIR_WIP_RESTORED',
            'PASS',
            'Full-suite repair parent WIP restored after repair child completion.',
            {
                manifest_path: normalizePath(manifestPath),
                child_task_id: manifest.child_task_id,
                restored_files: [...restoredFiles].sort(),
                parent_status_sync: parentResume
            },
            { actor: 'orchestrator' }
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const wipRollbackViolations = rollbackFullSuiteRepairRestore({
            repoRoot,
            manifest,
            patchSnapshots,
            stagedApplied,
            unstagedApplied,
            createdUntrackedFiles
        });
        const statusRollbackViolations = rollbackParentTaskStatusAfterWipRestore(
            repoRoot,
            manifest.task_id,
            parentResume
        );
        const rollbackViolations = [...wipRollbackViolations, ...statusRollbackViolations];
        return buildRestoreTransactionBlockedResult({
            repoRoot,
            taskId,
            manifestPath,
            restoredFiles,
            violations: [
                `mandatory restored-event append failed: ${message}`,
                ...rollbackViolations
            ],
            rollbackIncomplete: rollbackViolations.length > 0
        });
    }

    return {
        status: 'RESTORED',
        manifest_path: normalizePath(manifestPath),
        restored_files: [...restoredFiles].sort(),
        violations: [],
        output_lines: formatFullSuiteRepairOutput({
            repoRoot,
            taskId,
            gate: 'full-suite-repair-wip-restore',
            status: 'RESTORED',
            action: 'Continue the parent task through the navigator.',
            reason: 'Full-suite repair parent WIP restored after repair child completion.',
            detailsPath: manifestPath,
            legacyLines: [
                'FULL_SUITE_REPAIR_WIP_RESTORED',
                `ManifestPath: ${normalizePath(manifestPath)}`,
                `RestoredFiles: ${[...restoredFiles].sort().join(', ') || 'none'}`,
                `ParentStatusSync: ${parentResume.outcome}${parentResume.error_message ? ` (${parentResume.error_message})` : ''}`
            ]
        })
    };
}

function buildRestoreLockBlockedResult(params: {
    repoRoot: string;
    taskId: string;
    manifestPath: string;
    violation: string;
}): FullSuiteRepairWipRestoreResult {
    return {
        status: 'BLOCKED',
        manifest_path: normalizePath(params.manifestPath),
        restored_files: [],
        violations: [params.violation],
        output_lines: formatFullSuiteRepairOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            gate: 'full-suite-repair-wip-restore',
            status: 'BLOCKED',
            action: 'Resolve the restore lock blocker before retrying WIP restore.',
            reason: params.violation,
            detailsPath: params.manifestPath,
            legacyLines: [
                'FULL_SUITE_REPAIR_WIP_RESTORE_BLOCKED',
                `Violation: ${params.violation}`
            ]
        })
    };
}

export function restoreFullSuiteRepairWip(params: RestoreFullSuiteRepairWipParams): FullSuiteRepairWipRestoreResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    let manifestPath = '';
    try {
        manifestPath = resolveInputPathInsideRepo(repoRoot, params.manifestPath, 'ManifestPath');
    } catch {
        return restoreFullSuiteRepairWipUnlocked(params);
    }
    const containmentViolations = validatePhysicalRepoContainment(repoRoot, manifestPath, 'ManifestPath');
    if (containmentViolations.length > 0) {
        return buildRestoreLockBlockedResult({
            repoRoot,
            taskId: params.taskId,
            manifestPath,
            violation: `restore lock containment failed: ${containmentViolations.join(' ')}`
        });
    }
    let canonicalManifestPath = '';
    try {
        if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
            return restoreFullSuiteRepairWipUnlocked(params);
        }
        canonicalManifestPath = fs.realpathSync.native(manifestPath);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return buildRestoreLockBlockedResult({
            repoRoot,
            taskId: params.taskId,
            manifestPath,
            violation: `restore lock manifest inspection failed: ${message}`
        });
    }
    const lockPath = `${canonicalManifestPath}.restore.lock`;
    const lockContainmentViolations = validatePhysicalRepoContainment(repoRoot, lockPath, 'restore lock path');
    if (lockContainmentViolations.length > 0) {
        return buildRestoreLockBlockedResult({
            repoRoot,
            taskId: params.taskId,
            manifestPath,
            violation: `restore lock containment failed: ${lockContainmentViolations.join(' ')}`
        });
    }
    try {
        return withFilesystemLock(lockPath, {
            ownerLabel: `full-suite-repair-wip-restore:${String(params.taskId || '').trim() || 'unknown'}`,
            timeoutMs: 5000
        }, () => restoreFullSuiteRepairWipUnlocked(params)).result;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return buildRestoreLockBlockedResult({
            repoRoot,
            taskId: params.taskId,
            manifestPath,
            violation: `restore lock acquisition failed: ${message}`
        });
    }
}
