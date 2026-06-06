import * as fs from 'node:fs';

import { buildRawOutputRetentionEvidence } from '../../../../gate-runtime/output-log-retention';
import type { FullSuiteValidationResult } from '../../../../gates/full-suite/full-suite-validation';
import * as gateHelpers from '../../../../gates/shared/helpers';

export function shouldOmitSuccessfulFullSuiteOutput(
    result: Pick<FullSuiteValidationResult, 'status' | 'warnings'>
): boolean {
    return result.status === 'PASSED' && result.warnings.length === 0;
}

export function normalizeSuccessfulFullSuiteOutputRetention(
    repoRoot: string,
    artifactOutputPath: string,
    result: FullSuiteValidationResult
): FullSuiteValidationResult {
    if (!shouldOmitSuccessfulFullSuiteOutput(result)) {
        return result;
    }

    let rawOutputText = '';
    const resolvedOutputArtifactPath = gateHelpers.resolvePathInsideRepo(
        result.output_artifact_path || artifactOutputPath,
        repoRoot,
        { allowMissing: true }
    );
    if (resolvedOutputArtifactPath && fs.existsSync(resolvedOutputArtifactPath) && fs.statSync(resolvedOutputArtifactPath).isFile()) {
        rawOutputText = fs.readFileSync(resolvedOutputArtifactPath, 'utf8');
        fs.rmSync(resolvedOutputArtifactPath, { force: true });
    }

    return {
        ...result,
        output_artifact_path: null,
        output_retention: result.output_retention || buildRawOutputRetentionEvidence(rawOutputText, false)
    };
}
