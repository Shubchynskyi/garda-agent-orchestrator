import type {
    FullSuiteValidationConfig,
    FullSuiteValidationCycleBinding,
    FullSuiteValidationResult
} from '../../../../gates/full-suite/full-suite-validation';

export function buildWorkflowConfigWorkBlockedResult(
    config: FullSuiteValidationConfig,
    cycleBinding: FullSuiteValidationCycleBinding,
    violations: string[],
    scanError: string | null
): FullSuiteValidationResult {
    return {
        status: 'FAILED',
        enabled: config.enabled,
        command: config.command,
        exit_code: null,
        timed_out: false,
        output_artifact_path: null,
        compact_summary: ['Workflow config change is not authorized for this task mode.'],
        failure_chunks: [],
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: false,
        out_of_scope_audit_verdict: 'NOT_APPLICABLE',
        violations,
        warnings: scanError ? [`Workflow config workspace scan warning: ${scanError}`] : [],
        cycle_binding: cycleBinding
    };
}
