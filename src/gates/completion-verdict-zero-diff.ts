/**
 * Zero-diff guard evaluator for the completion gate.
 * Detects clean-tree preflight and ensures an audited no-op artifact exists
 * before the task can reach DONE.
 */

import { normalizePath } from './helpers';
import type { NoOpEvidenceResult } from './no-op';

export interface ZeroDiffCompletionEvidence {
    zero_diff_detected: boolean;
    status: 'NOT_APPLICABLE' | 'REQUIRES_AUDITED_NO_OP' | 'SATISFIED_BY_AUDITED_NO_OP';
    no_op_evidence_path: string | null;
    no_op_classification: string | null;
    no_op_reason: string | null;
    violations: string[];
}

function detectZeroDiffPreflight(preflight: Record<string, unknown> | null): boolean {
    if (!preflight) return false;
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : null;
    const changedLinesTotal = metrics && typeof metrics.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : 0;
    const changedFilesCount = Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0;
    return changedLinesTotal === 0 && changedFilesCount === 0;
}

export function validateZeroDiffCompletionEvidence(
    preflight: Record<string, unknown> | null,
    taskId: string,
    taskSummary: string | null,
    noOpEvidence: NoOpEvidenceResult
): ZeroDiffCompletionEvidence {
    const zeroDiffDetected = detectZeroDiffPreflight(preflight);
    if (!zeroDiffDetected) {
        return {
            zero_diff_detected: false,
            status: 'NOT_APPLICABLE',
            no_op_evidence_path: noOpEvidence.evidence_path,
            no_op_classification: noOpEvidence.classification,
            no_op_reason: noOpEvidence.reason,
            violations: []
        };
    }

    if (noOpEvidence.evidence_status === 'PASS') {
        return {
            zero_diff_detected: true,
            status: 'SATISFIED_BY_AUDITED_NO_OP',
            no_op_evidence_path: noOpEvidence.evidence_path,
            no_op_classification: noOpEvidence.classification,
            no_op_reason: noOpEvidence.reason,
            violations: []
        };
    }

    const summarySuffix = taskSummary ? ` (${taskSummary})` : '';
    return {
        zero_diff_detected: true,
        status: 'REQUIRES_AUDITED_NO_OP',
        no_op_evidence_path: noOpEvidence.evidence_path,
        no_op_classification: noOpEvidence.classification,
        no_op_reason: noOpEvidence.reason,
        violations: [
            `Task '${taskId}'${summarySuffix} has zero-diff preflight on a clean tree. ` +
            'Baseline-only preflight cannot complete the task by itself. ' +
            `Produce a real diff or record an audited no-op artifact at '${normalizePath(noOpEvidence.evidence_path || '')}' before DONE.`
        ]
    };
}
