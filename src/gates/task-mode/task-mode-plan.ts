import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveBundleNameForTarget } from '../../core/constants';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { fileSha256, joinOrchestratorPath, normalizePath } from '../shared/helpers';
import type { TaskModeMarkdownWorkingPlanMetadata } from './task-mode-contracts';

function getMarkdownWorkingPlanPathCandidates(repoRoot: string, taskId: string): string[] {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const safeTaskId = assertValidTaskId(taskId);
    const fileName = `${safeTaskId}.md`;
    const candidates = [
        path.resolve(normalizedRepoRoot, resolveBundleNameForTarget(normalizedRepoRoot), 'runtime', 'plans', fileName),
        joinOrchestratorPath(normalizedRepoRoot, path.join('runtime', 'plans', fileName))
    ];
    return [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
}

export function resolveMarkdownWorkingPlanPath(repoRoot: string, taskId: string): string {
    const [firstCandidate] = getMarkdownWorkingPlanPathCandidates(repoRoot, taskId);
    if (!firstCandidate) {
        throw new Error('Unable to resolve Markdown working-plan path.');
    }
    return firstCandidate;
}

export function readOptionalMarkdownWorkingPlan(
    repoRoot: string,
    taskId: string
): TaskModeMarkdownWorkingPlanMetadata | null {
    const normalizedRepoRoot = path.resolve(repoRoot);
    for (const candidatePath of getMarkdownWorkingPlanPathCandidates(normalizedRepoRoot, taskId)) {
        if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isFile()) {
            continue;
        }
        const workingPlanSha256 = fileSha256(candidatePath);
        if (!workingPlanSha256) {
            continue;
        }
        const relativePath = path.relative(normalizedRepoRoot, candidatePath);
        return {
            format: 'markdown',
            working_plan_path: normalizePath(
                relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)
                    ? relativePath
                    : candidatePath
            ),
            working_plan_sha256: workingPlanSha256,
            byte_count: fs.statSync(candidatePath).size
        };
    }
    return null;
}
