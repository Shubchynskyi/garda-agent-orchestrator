import type { FullSuiteValidationPlacement } from '../../core/workflow-config';
import type { RawOutputRetentionEvidence } from '../../gate-runtime/output-log-retention';

export const OUT_OF_SCOPE_FAILURE_POLICIES = Object.freeze([
    'AUDIT_AND_BLOCK',
    'AUDIT_AND_WARN'
] as const);

export type OutOfScopeFailurePolicy = (typeof OUT_OF_SCOPE_FAILURE_POLICIES)[number];

export interface FullSuiteValidationConfig {
    readonly enabled: boolean;
    readonly command: string;
    readonly timeout_ms: number;
    readonly green_summary_max_lines: number;
    readonly red_failure_chunk_lines: number;
    readonly out_of_scope_failure_policy: OutOfScopeFailurePolicy;
    readonly placement: FullSuiteValidationPlacement;
}

export interface FullSuiteValidationCycleBinding {
    task_id: string;
    preflight_path: string;
    preflight_sha256: string;
    compile_gate_timestamp: string | null;
    scope_binding?: {
        changed_files_sha256: string | null;
        scope_sha256: string | null;
        scope_content_sha256: string | null;
    } | null;
}

export interface FullSuiteDurationHistoryEntry {
    timestamp_utc: string;
    task_id: string;
    status: 'PASSED' | 'FAILED' | 'WARNED';
    command: string;
    config_signature_sha256: string;
    duration_ms: number;
    timed_out: boolean;
    exit_code: number | null;
}

export interface FullSuiteDurationHistory {
    schema_version: 1;
    history_limit: number;
    updated_at_utc: string;
    entries: FullSuiteDurationHistoryEntry[];
}

export interface FullSuiteTimeoutForecast {
    history_path: string;
    sample_count: number;
    average_duration_seconds: number | null;
    high_watermark_duration_seconds: number | null;
    recommended_timeout_seconds: number;
    safety_margin_seconds: number | null;
    recommendation_source: 'history' | 'config_timeout';
    configured_timeout_seconds: number;
    warning: string | null;
}

export interface FullSuitePerformanceGuidance {
    mode: 'standard' | 'optimized_sharded' | 'optimized_reuse_aware' | 'optimized_sharded_reuse_aware';
    optimized: boolean;
    mandatory_boundary: string;
    optimized_command: string | null;
    fallback_command: string | null;
}

export interface FullSuiteValidationResult {
    status: 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED';
    enabled: boolean;
    command: string;
    exit_code: number | null;
    timed_out: boolean;
    output_artifact_path: string | null;
    output_retention?: RawOutputRetentionEvidence | null;
    compact_summary: string[];
    failure_chunks: string[][];
    out_of_scope_failure_policy: OutOfScopeFailurePolicy;
    out_of_scope_failure_detected: boolean;
    out_of_scope_audit_verdict: 'BLOCKED' | 'WARNED' | 'NOT_APPLICABLE';
    harness_failure_detected?: boolean;
    harness_failure_audit_verdict?: 'WARNED' | 'NOT_APPLICABLE';
    harness_failure_reason?: string | null;
    required?: boolean;
    skip_reason?: string | null;
    violations: string[];
    warnings: string[];
    output_telemetry?: Record<string, unknown> | null;
    duration_ms?: number | null;
    timeout_forecast?: FullSuiteTimeoutForecast | null;
    cycle_binding?: FullSuiteValidationCycleBinding;
    failure_evidence?: FullSuiteFailureEvidence | null;
}

export interface FullSuiteFailureEvidenceCopiedLog {
    source_path: string;
    artifact_path: string;
    sha256: string;
    bytes: number;
    lines: number;
    truncated: boolean;
}

export interface FullSuiteFailureEvidence {
    schema_version: 1;
    task_id: string;
    status: 'FAILED' | 'WARNED';
    command: string;
    exit_code: number | null;
    timed_out: boolean;
    output_artifact_path: string | null;
    summary_artifact_path: string;
    copied_logs: FullSuiteFailureEvidenceCopiedLog[];
    copied_logs_count: number;
    max_copied_logs: number;
    max_log_chars: number;
    failure_chunks: string[][];
    compact_summary: string[];
    last_output_lines: string[];
    shard_diagnostics: string[];
    timeout_diagnostics: string[];
}

export interface FullSuiteFailureEvidenceOptions {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    result: FullSuiteValidationResult;
    outputLines: string[];
    maxCopiedLogs?: number;
    maxLogChars?: number;
}
