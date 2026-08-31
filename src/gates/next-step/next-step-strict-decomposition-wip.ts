import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    captureAndSuspendSplitRequiredWip
} from '../split-required/split-required-wip-capture';
import type {
    SplitRequiredWipCaptureResult
} from '../split-required/split-required-wip-contracts';
import {
    getStrictDecompositionDecisionEvidence,
    type StrictDecompositionDecisionEvidenceResult
} from '../task-mode/strict-decomposition-decision';
import {
    joinOrchestratorPath
} from '../shared/helpers';

export type StrictDecompositionWipSuspensionResult = SplitRequiredWipCaptureResult | {
    status: 'NOT_REQUIRED';
    manifest_path: null;
    manifest_sha256: null;
    tracked_files: string[];
    untracked_files: string[];
    violations: string[];
};

export function suspendStrictDecompositionWipIfRequired(params: {
    repoRoot: string;
    taskId: string;
    evidence?: StrictDecompositionDecisionEvidenceResult;
}): StrictDecompositionWipSuspensionResult {
    const evidence = params.evidence || getStrictDecompositionDecisionEvidence(
        params.repoRoot,
        params.taskId
    );
    if (evidence.evidence_status !== 'PASS' || evidence.decision !== 'split-required') {
        return {
            status: 'NOT_REQUIRED',
            manifest_path: null,
            manifest_sha256: null,
            tracked_files: [],
            untracked_files: [],
            violations: []
        };
    }

    const preflightPath = joinOrchestratorPath(
        params.repoRoot,
        path.join('runtime', 'reviews', `${params.taskId}-preflight.json`)
    );
    if (!fs.existsSync(preflightPath)) {
        return {
            status: 'NOT_REQUIRED',
            manifest_path: null,
            manifest_sha256: null,
            tracked_files: [],
            untracked_files: [],
            violations: []
        };
    }

    return captureAndSuspendSplitRequiredWip({
        repoRoot: params.repoRoot,
        taskId: params.taskId,
        preflightPath,
        guardKind: 'strict_decomposition',
        guardReason:
            'A current strict decomposition decision requires the implemented parent scope to be suspended before child execution.'
    });
}
