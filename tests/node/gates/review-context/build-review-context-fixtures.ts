import assertModule from 'node:assert/strict';
import * as cryptoModule from 'node:crypto';
import * as fsModule from 'node:fs';
import * as osModule from 'node:os';
import * as pathModule from 'node:path';
import * as childProcessModule from 'node:child_process';

import { runGitFixtureCommand } from '../git-fixtures';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { buildReviewContext, getRulePack, toNonNegativeInt, resolveContextOutputPath, resolveScopedDiffMetadataPath } from '../../../../src/gates/review-context/build-review-context';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';
import { buildChangedFileFingerprintEntries } from '../../../../src/gates/review-context/review-context-diff';
import { buildReviewTreeState } from '../../../../src/gates/review/review-tree-state';
import {
    getCanonicalReviewContextPath,
    getLegacyDefaultReviewContextPath,
    resolveCanonicalReviewContextPath
} from '../../../../src/gates/review-context/review-context-paths';
import { computeReviewContextReuseHash } from '../../../../src/gates/review-reuse';
import { buildTaskModeArtifact, getTaskModeEvidence, resolveTaskModeArtifactPath } from '../../../../src/gates/task-mode';
import { resolveReviewerRoutingPolicy, resolveRuntimeReviewerIdentity } from '../../../../src/gates/review/reviewer-routing';
import { REVIEW_CONTRACTS } from '../../../../src/gates/required-reviews/required-reviews-check';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';

export const assert: typeof assertModule = assertModule;
export const crypto: typeof cryptoModule = cryptoModule;
export const fs: typeof fsModule = fsModule;
export const os: typeof osModule = osModule;
export const path: typeof pathModule = pathModule;
export const childProcess: typeof childProcessModule = childProcessModule;

export {
    appendTaskEvent,
    buildReviewContext,
    getRulePack,
    toNonNegativeInt,
    resolveContextOutputPath,
    resolveScopedDiffMetadataPath,
    getWorkspaceSnapshot,
    buildChangedFileFingerprintEntries,
    buildReviewTreeState,
    getCanonicalReviewContextPath,
    getLegacyDefaultReviewContextPath,
    resolveCanonicalReviewContextPath,
    computeReviewContextReuseHash,
    buildTaskModeArtifact,
    getTaskModeEvidence,
    resolveTaskModeArtifactPath,
    resolveReviewerRoutingPolicy,
    resolveRuntimeReviewerIdentity,
    REVIEW_CONTRACTS,
    serializeTaskPlan,
    validateTaskPlan
};

export function runGit(repoRoot: string, args: string[]): void {
    runGitFixtureCommand(repoRoot, [
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.safecrlf=false',
        ...args
    ]);
}

export function sha256Text(text: string): string {
    return cryptoModule.createHash('sha256').update(text).digest('hex');
}

export function cloneJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function writeTaskModeArtifactFixture(
    repoRoot: string,
    taskId: string,
    options: {
        provider: string | null;
        canonicalSourceOfTruth: string | null;
        routedTo?: string | null;
        executionProviderSource?: string | null;
        runtimeIdentityStatus?: string | null;
        materializeRoutedTo?: boolean;
        reviewerSubagentLaunchStatus?: 'launchable' | 'blocked' | 'unknown' | null;
        reviewerSubagentLaunchRoute?: string | null;
        reviewerSubagentLaunchReason?: string | null;
        reviewerSubagentLaunchRemediation?: string | null;
        taskSummary?: string;
        plan?: {
            plan_path: string;
            plan_sha256: string;
            plan_summary: string;
        } | null;
    }
): void {
    const normalizedRoutedTo = options.routedTo ? String(options.routedTo).replace(/\\/g, '/').replace(/^\.\//, '') : null;
    if (normalizedRoutedTo && options.materializeRoutedTo !== false) {
        const routePath = pathModule.join(repoRoot, normalizedRoutedTo);
        fsModule.mkdirSync(pathModule.dirname(routePath), { recursive: true });
        if (!fsModule.existsSync(routePath)) {
            fsModule.writeFileSync(routePath, '# routed workflow fixture\n', 'utf8');
        }
    }
    const taskModePath = resolveTaskModeArtifactPath(repoRoot, taskId, '');
    fsModule.writeFileSync(taskModePath, JSON.stringify(buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 3,
        effectiveDepth: 3,
        taskSummary: options.taskSummary || 'Enforce delegated reviewer routing',
        provider: options.provider,
        canonicalSourceOfTruth: options.canonicalSourceOfTruth,
        routedTo: options.routedTo ?? null,
        executionProviderSource: options.executionProviderSource ?? null,
        runtimeIdentityStatus: options.runtimeIdentityStatus ?? null,
        reviewerSubagentLaunchStatus: options.reviewerSubagentLaunchStatus ?? null,
        reviewerSubagentLaunchRoute: options.reviewerSubagentLaunchRoute ?? null,
        reviewerSubagentLaunchReason: options.reviewerSubagentLaunchReason ?? null,
        reviewerSubagentLaunchRemediation: options.reviewerSubagentLaunchRemediation ?? null,
        plan: options.plan ?? null
    }), null, 2), 'utf8');
}
