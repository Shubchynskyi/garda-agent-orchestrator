import * as path from 'node:path';
import * as fs from 'node:fs';
import { ensureDirectory, pathExists } from '../../core/filesystem';
import { readJsonFile, writeJsonFile } from '../../core/json';
import { getSkillsHeadlinesConfigPath } from '../skill-headlines';
import {
    type OptionalSkillSelectionArtifactData,
    type OptionalSkillSelectionArtifact,
    type WriteOptionalSkillSelectionOptions,
    toPortableBundlePath,
    computeFileSha256,
    computeOptionalSkillTaskTextSha256,
    uniqueSorted
} from './types';
import { readOptionalSkillSelectionPolicyConfig } from './config';
import { materializeCurrentHeadlinesSurface } from './headlines-cache';
import { buildOptionalSkillSelectionArtifact } from './artifact-builder';
import { getOptionalSkillSelectionArtifactViolations } from './artifact-validation';

export function getOptionalSkillSelectionArtifactPath(bundleRoot: string, taskId: string): string {
    return path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-optional-skill-selection.json`);
}

export function readOptionalSkillSelectionArtifact(
    bundleRoot: string,
    taskId: string
): OptionalSkillSelectionArtifactData | null {
    const artifactPath = getOptionalSkillSelectionArtifactPath(bundleRoot, taskId);
    if (!pathExists(artifactPath)) {
        return null;
    }
    try {
        return {
            artifactPath,
            payload: readJsonFile(artifactPath) as OptionalSkillSelectionArtifact
        };
    } catch {
        return null;
    }
}

export function writeOptionalSkillSelectionArtifact(
    bundleRoot: string,
    taskId: string,
    options: WriteOptionalSkillSelectionOptions = {}
): OptionalSkillSelectionArtifactData {
    const builtArtifact = options.preparedArtifact || buildOptionalSkillSelectionArtifact(bundleRoot, taskId, options);
    const resolvedPreflightPath = options.preflightPath ? String(options.preflightPath).replace(/\\/g, '/') : null;
    const resolvedPreflightSha256 = typeof options.preflightSha256 === 'string'
        ? options.preflightSha256.trim() || null
        : computeFileSha256(options.preflightPath || null);
    const currentHeadlines = builtArtifact.payload.policy_mode === 'off'
        ? null
        : materializeCurrentHeadlinesSurface(
            bundleRoot,
            builtArtifact.loadedHeadlinesCache || options.loadedHeadlinesCache || null
        );
    const resolvedHeadlinesCache = currentHeadlines
        ? {
            headlinesPath: currentHeadlines.headlinesPath,
            headlinesSha256: currentHeadlines.headlinesSha256,
            materializationNeeded: false,
            skills: Array.isArray(currentHeadlines.payload.skills) ? currentHeadlines.payload.skills : [],
            optional_packs: Array.isArray(currentHeadlines.payload.optional_packs) ? currentHeadlines.payload.optional_packs : [],
            payload: currentHeadlines.payload
        }
        : null;
    const resolvedHeadlinesPath = currentHeadlines?.headlinesPath || getSkillsHeadlinesConfigPath(bundleRoot);
    const resolvedHeadlinesSha256 = currentHeadlines?.headlinesSha256 || computeFileSha256(resolvedHeadlinesPath);
    const artifact: OptionalSkillSelectionArtifactData = {
        artifactPath: getOptionalSkillSelectionArtifactPath(bundleRoot, taskId),
        payload: {
            ...builtArtifact.payload,
            task_id: taskId,
            timestamp_utc: new Date().toISOString(),
            task_text_present: typeof options.taskText === 'string'
                ? options.taskText.trim().length > 0
                : builtArtifact.payload.task_text_present,
            task_text_sha256: typeof options.taskText === 'string'
                ? computeOptionalSkillTaskTextSha256(options.taskText)
                : builtArtifact.payload.task_text_sha256,
            changed_paths: Array.isArray(options.changedPaths)
                ? uniqueSorted(options.changedPaths.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean))
                : builtArtifact.payload.changed_paths,
            preflight_path: resolvedPreflightPath,
            preflight_sha256: resolvedPreflightSha256,
            headlines_path: toPortableBundlePath(bundleRoot, resolvedHeadlinesPath),
            headlines_sha256: resolvedHeadlinesSha256
        },
        loadedHeadlinesCache: resolvedHeadlinesCache
    };
    ensureDirectory(path.dirname(artifact.artifactPath));
    writeJsonFile(artifact.artifactPath, artifact.payload);
    const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, {
        requireMaterializedArtifact: true,
        expectedPreflightPath: options.preflightPath || null,
        expectedPreflightSha256: options.preflightSha256 || null,
        expectedPolicyMode: readOptionalSkillSelectionPolicyConfig(bundleRoot).mode,
        loadedHeadlinesCache: artifact.loadedHeadlinesCache || null
    });
    if (violations.length > 0) {
        fs.rmSync(artifact.artifactPath, { force: true });
        throw new Error(violations.join(' '));
    }
    return artifact;
}
