import * as path from 'node:path';
import { validateManifest } from './validate-manifest';
import {
    evaluateProtectedControlPlaneManifest,
    type ProtectedControlPlaneManifestEvidence
} from '../gates/helpers';

export interface ManifestEvidence {
    manifestResult: ReturnType<typeof validateManifest> | null;
    manifestError: string | null;
    protectedManifestEvidence: ProtectedControlPlaneManifestEvidence | null;
}

export function collectManifestEvidence(
    bundlePath: string,
    targetRoot: string
): ManifestEvidence {
    const manifestPath = path.join(bundlePath, 'MANIFEST.md');
    let manifestResult: ReturnType<typeof validateManifest> | null = null;
    let manifestError: string | null = null;

    try {
        manifestResult = validateManifest(manifestPath, targetRoot);
    } catch (err: unknown) {
        manifestError = getErrorMessage(err);
    }

    let protectedManifestEvidence: ProtectedControlPlaneManifestEvidence | null = null;
    try {
        protectedManifestEvidence = evaluateProtectedControlPlaneManifest(targetRoot, null, true);
    } catch {
        // evaluation failure is non-fatal; will show as null in output
    }

    return { manifestResult, manifestError, protectedManifestEvidence };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
