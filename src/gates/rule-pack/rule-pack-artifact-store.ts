import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import {
    isPathRealpathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import { type RulePackArtifact } from './rule-pack-types';
import { isRecord } from './rule-pack-records';

export function readExistingRulePackArtifact(artifactPath: string): RulePackArtifact | null {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        if (!isRecord(parsed) || !isRecord(parsed.stages)) {
            return null;
        }
        return parsed as unknown as RulePackArtifact;
    } catch {
        return null;
    }
}

export function resolveRulePackArtifactPath(repoRoot: string, taskId: string, artifactPath: string): string {
    const resolvedTaskId = assertValidTaskId(taskId);
    const explicitPath = String(artifactPath || '').trim();
    const resolvedPath = explicitPath
        ? resolvePathInsideRepo(explicitPath, repoRoot, {
            allowMissing: true,
            enforceInside: true
        })
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${resolvedTaskId}-rule-pack.json`));
    if (!resolvedPath) {
        throw new Error('RulePackArtifactPath must not be empty.');
    }
    if (!isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: true })) {
        throw new Error(
            `RulePackArtifactPath must resolve inside repo root without symlink or junction escape: ${normalizePath(resolvedPath)}.`
        );
    }
    return resolvedPath;
}
