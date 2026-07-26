import * as path from 'node:path';

import { writeReviewArtifactJson } from '../../../../gate-runtime/review-artifacts';
import { getWorkspaceSnapshot } from '../../../../gates/compile/compile-gate';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { normalizeChangedFiles } from './recovery-flow-shared';
import type {
    ResolvedReplayScope,
    ReviewRemediationScopeBoundary
} from './recovery-flow-types';

export function resolveCurrentRemediationChangedFiles(
    repoRoot: string,
    replayScope: ResolvedReplayScope
): string[] {
    const detectionSource = replayScope.useStaged
        ? (replayScope.includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only')
        : 'git_auto';
    const includeUntracked = replayScope.includeUntracked ?? !replayScope.useStaged;
    const snapshot = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, []);
    return normalizeChangedFiles([
        ...(replayScope.changedFiles ?? []),
        ...(snapshot.changed_files as string[])
    ]);
}

export function writeReviewRemediationCycleArtifact(
    repoRoot: string,
    taskId: string,
    artifact: Record<string, unknown>
): string {
    const artifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-review-remediation-cycle.json`)
    );
    writeReviewArtifactJson(artifactPath, artifact);
    return artifactPath;
}

export function resolveReviewRemediationClassifyChangedFiles(
    replayScope: ResolvedReplayScope,
    scopeBoundary: ReviewRemediationScopeBoundary,
    extraChangedFiles: readonly string[] = []
): string[] | undefined {
    const normalizedExtraChangedFiles = normalizeChangedFiles(extraChangedFiles);
    if (replayScope.changedFiles === undefined && normalizedExtraChangedFiles.length === 0) {
        return undefined;
    }
    return normalizeChangedFiles([
        ...scopeBoundary.previousChangedFiles,
        ...(replayScope.changedFiles ?? []),
        ...scopeBoundary.allowedTestOnlyExpansionFiles,
        ...normalizedExtraChangedFiles
    ]);
}
