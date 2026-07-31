import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    appendMandatoryTaskEvent
} from '../../gate-runtime/task-events';
import {
    runGit
} from '../../core/git-helpers';
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
    SplitRequiredWipRestoreResult,
    SplitRequiredWipRetireResult,
    SplitRequiredWipTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence
} from './split-required-wip-contracts';
import {
    applyAdvancedRestorePlan,
    buildGitApplyIncludeArgs,
    ensureCleanTrackedWorkspace,
    gitFailureMessage,
    hasPatchContent,
    normalizeSelectedPaths,
    planAdvancedRestore,
    runGitStatus,
    selectedFiles,
    validateAdvancedManifestBlobs,
    validateManifestFileReferences,
    validateNoSymlinkPath,
    validateSelectedTargetsClean,
    validateTrackedTargetObstructions
} from './split-required-wip-restore-plan';
import type { AdvancedRestorePlan } from './split-required-wip-restore-plan';

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
        const effectiveSelectedPaths = new Set(
            [...selectedTrackedFiles, ...selectedUntrackedFiles]
                .map((entry) => normalizeGitPath(entry.path))
        );
        for (const selectedPath of effectiveSelectedPaths) {
            violations.push(...validateNoSymlinkPath(repoRoot, selectedPath));
        }
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
            fs.rmSync(advancedPlan.tempRoot, { recursive: true, force: true });
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
        fs.rmSync(advancedPlan.tempRoot, { recursive: true, force: true });
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
