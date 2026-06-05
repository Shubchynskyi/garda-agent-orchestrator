import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256, normalizePath } from './review-launch-entrypoints';
import type { SupersededReviewerLaunchArtifactSnapshot } from './review-launch-artifact-fields';

export function snapshotSupersededReviewerLaunchArtifact(options: {
    artifactPath: string;
    mismatches: string[];
}): SupersededReviewerLaunchArtifactSnapshot {
    const artifactSha256 = fileSha256(options.artifactPath);
    if (!artifactSha256) {
        throw new Error(`Reviewer launch artifact could not be hashed before supersession: ${normalizePath(options.artifactPath)}.`);
    }
    const parsedPath = path.parse(options.artifactPath);
    const snapshotPath = path.join(
        parsedPath.dir,
        `${parsedPath.name}-superseded-${artifactSha256}${parsedPath.ext || '.json'}`
    );
    if (!fs.existsSync(snapshotPath)) {
        fs.copyFileSync(options.artifactPath, snapshotPath);
    }
    const mismatches = options.mismatches.length > 0
        ? options.mismatches
        : ['existing reviewer launch artifact is not current for this preparation'];
    return {
        artifact_path: normalizePath(options.artifactPath),
        artifact_sha256: artifactSha256,
        snapshot_path: normalizePath(snapshotPath),
        superseded_reason: mismatches.join('; '),
        mismatches
    };
}

