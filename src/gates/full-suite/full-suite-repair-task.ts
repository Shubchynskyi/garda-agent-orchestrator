import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    runGit,
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
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    buildRestoreFullSuiteRepairWipCommand,
    formatFullSuiteRepairOutput,
    normalizeGitPath,
    resolveRepoPath
} from './full-suite-repair-contracts';
import type {
    CapturedPatchEvidence,
    CapturedUntrackedFileEvidence,
    FullSuiteRepairWipRestoreResult,
    ParentResumeStatusResult,
    PatchPathRecord,
    RepairWipManifest,
    RestoreFullSuiteRepairWipParams,
    RestoreMutationInspection,
    RestorePatchSnapshots
} from './full-suite-repair-contracts';
import {
    hasPatchContent,
    readImmutableRegularFileSnapshot
} from './full-suite-repair-capture';
import type {
    CaptureFileSnapshot
} from './full-suite-repair-capture';
import {
    getHeadCommit,
    gitFailureMessage,
    parseRepairWipManifest,
    resolveInputPathInsideRepo,
    restoreContainedUntrackedFile,
    runGitStatus,
    runGitWithInput,
    sameFileIdentity,
    sameFileSnapshot,
    validateManifestRelativePath,
    validatePhysicalRepoContainment
} from './full-suite-repair-manifest';
import {
    readFullSuiteRepairTaskMaterializationEvidence
} from './full-suite-repair-materialization';

export type {
    FullSuiteRepairTaskMaterializationResult,
    FullSuiteRepairTaskProposal,
    FullSuiteRepairWipRestoreResult
} from './full-suite-repair-contracts';
export {
    materializeFullSuiteRepairTask,
    resolveFullSuiteRepairTaskArtifactPath
} from './full-suite-repair-materialization';
export {
    readFullSuiteRepairTaskMaterializationEvidence
};

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
