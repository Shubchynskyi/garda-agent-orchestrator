import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { joinOrchestratorPath, resolvePathInsideRepo } from '../shared/helpers';
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
    if (explicitPath) {
        const resolvedPath = resolvePathInsideRepo(explicitPath, repoRoot, { allowMissing: true });
        if (!resolvedPath) {
            throw new Error('RulePackArtifactPath must not be empty.');
        }
        return resolvedPath;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${resolvedTaskId}-rule-pack.json`));
}
