import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    assertValidTaskId
} from '../../gate-runtime/task-events';
import {
    resolveEventsRoot,
    resolveReviewsRoot
} from '../task-audit/task-audit-summary-collectors';
import {
    buildBundleRelativePath
} from './next-step-command-formatters';
import {
    readNextStepReadinessArtifacts,
    type NextStepReadinessArtifacts
} from './next-step-readiness-readers';
import {
    resolveActiveTaskModeArtifactPath
} from './next-step-preflight-recovery';

export interface NextStepOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
}

export interface NextStepResolutionContext {
    repoRoot: string;
    taskId: string;
    reviewsRoot: string;
    eventsRoot: string;
    cliPrefix: string;
    taskModePath: string;
    preflightCommandPath: string;
    readinessArtifacts: NextStepReadinessArtifacts;
    preflightPath: string;
    rulePackPath: string;
    preflight: Record<string, unknown> | null;
    rulePack: Record<string, unknown> | null;
    taskMode: Record<string, unknown> | null;
    preflightSha256: string | null;
}

export function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? 'node bin/garda.js'
        : `node ${resolveBundleNameForTarget(repoRoot)}/bin/garda.js`;
}

export function createNextStepResolutionContext(options: NextStepOptions): NextStepResolutionContext {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(options.taskId);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const cliPrefix = buildCliPrefix(repoRoot);
    const taskModePath = resolveActiveTaskModeArtifactPath(repoRoot, eventsRoot, reviewsRoot, taskId);
    const preflightCommandPath = buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`);
    const readinessArtifacts = readNextStepReadinessArtifacts({
        reviewsRoot,
        taskId,
        taskModePath,
        preflightCommandPath
    });
    const { preflightPath, rulePackPath } = readinessArtifacts.paths;
    const { preflight, rulePack, taskMode, preflightSha256 } = readinessArtifacts;

    return {
        repoRoot,
        taskId,
        reviewsRoot,
        eventsRoot,
        cliPrefix,
        taskModePath,
        preflightCommandPath,
        readinessArtifacts,
        preflightPath,
        rulePackPath,
        preflight,
        rulePack,
        taskMode,
        preflightSha256
    };
}
