import { redactSecretText } from '../../core/redaction';
import { buildOutputTelemetry, formatVisibleSavingsLine } from '../../gate-runtime/token-telemetry';
import {
    formatFullSuitePerformanceGuidance,
    formatFullSuiteTimeoutForecast
} from './full-suite-validation-config';
import type { FullSuiteValidationResult } from './full-suite-validation-types';

function buildFullSuiteValidationOutputLines(result: FullSuiteValidationResult): string[] {
    const lines: string[] = [];
    lines.push(`FULL_SUITE_VALIDATION_${result.status}`);
    lines.push(`Enabled: ${result.enabled}`);
    lines.push(`Command: ${redactSecretText(result.command)}`);
    lines.push(`PerformanceMode: ${formatFullSuitePerformanceGuidance(result.command)}`);
    if (typeof result.required === 'boolean') {
        lines.push(`Required: ${result.required}`);
    }
    if (result.skip_reason) {
        lines.push(`SkipReason: ${result.skip_reason}`);
    }

    if (result.exit_code !== null) {
        lines.push(`ExitCode: ${result.exit_code}`);
    }
    if (result.timed_out) {
        lines.push('TimedOut: true');
    }
    if (result.output_artifact_path) {
        lines.push(`OutputArtifact: ${result.output_artifact_path}`);
    } else if (result.output_retention?.raw_output_retained === false) {
        lines.push('OutputArtifact: intentionally omitted for clean success retention policy.');
    }
    if (result.output_retention) {
        lines.push(
            'OutputRetention: '
            + `retained=${String(result.output_retention.raw_output_retained)}; `
            + `reason=${result.output_retention.retention_reason}; `
            + `sha256=${result.output_retention.raw_output_sha256 || 'null'}; `
            + `lines=${result.output_retention.raw_output_line_count}; `
            + `chars=${result.output_retention.raw_output_char_count}`
        );
    }
    if (result.failure_evidence) {
        lines.push(
            'FailureEvidence: '
            + `summary=${result.failure_evidence.summary_artifact_path}; `
            + `copied_logs=${result.failure_evidence.copied_logs_count}; `
            + `kind=${result.failure_evidence.failure_kind}; `
            + `top_failures=${result.failure_evidence.top_failures.length}`
        );
        if (result.failure_evidence.top_failures.length > 0) {
            lines.push('TopFailures:');
            for (const failure of result.failure_evidence.top_failures.slice(0, 5)) {
                const detailParts = [
                    `kind=${failure.kind}`,
                    failure.test_name ? `test=${failure.test_name}` : null,
                    failure.file_path ? `file=${failure.line ? `${failure.file_path}:${failure.line}` : failure.file_path}` : null,
                    failure.artifact_path ? `artifact=${failure.artifact_path}` : null,
                    failure.source_path && failure.source_path !== failure.artifact_path ? `source=${failure.source_path}` : null,
                    `summary=${failure.summary}`
                ].filter((part): part is string => part !== null);
                lines.push(`  - ${detailParts.join('; ')}`);
            }
        }
    }
    if (typeof result.duration_ms === 'number') {
        lines.push(`DurationMs: ${result.duration_ms}`);
    }
    if (result.timeout_forecast) {
        lines.push(`TimeoutForecast: ${formatFullSuiteTimeoutForecast(result.timeout_forecast)}`);
        lines.push(`TimeoutForecastHistory: ${result.timeout_forecast.history_path}`);
    }
    if (result.cycle_binding) {
        lines.push(
            'CycleBinding: '
            + `task_id=${result.cycle_binding.task_id}; `
            + `preflight_path=${result.cycle_binding.preflight_path}; `
            + `preflight_sha256=${result.cycle_binding.preflight_sha256}; `
            + `compile_gate_timestamp=${result.cycle_binding.compile_gate_timestamp || 'null'}`
        );
    }

    if (result.compact_summary.length > 0) {
        lines.push('Summary:');
        for (const summaryLine of result.compact_summary) {
            lines.push(`  ${summaryLine}`);
        }
    }

    if (result.failure_chunks.length > 0) {
        lines.push(`FailureChunks: ${result.failure_chunks.length}`);
        for (let index = 0; index < result.failure_chunks.length; index += 1) {
            lines.push(`  --- Chunk ${index + 1} ---`);
            for (const chunkLine of result.failure_chunks[index]) {
                lines.push(`  ${chunkLine}`);
            }
        }
    }

    if (result.out_of_scope_failure_detected) {
        lines.push(`OutOfScopePolicy: ${result.out_of_scope_failure_policy}`);
        lines.push(`OutOfScopeAuditVerdict: ${result.out_of_scope_audit_verdict}`);
    }
    if (result.harness_failure_detected) {
        lines.push('HarnessFailureDetected: true');
        lines.push(`HarnessFailureAuditVerdict: ${result.harness_failure_audit_verdict || 'WARNED'}`);
        if (result.harness_failure_reason) {
            lines.push(`HarnessFailureReason: ${result.harness_failure_reason}`);
        }
    }

    if (result.violations.length > 0) {
        lines.push('Violations:');
        for (const violation of result.violations) {
            lines.push(`  - ${violation}`);
        }
    }
    if (result.warnings.length > 0) {
        lines.push('Warnings:');
        for (const warning of result.warnings) {
            lines.push(`  - ${warning}`);
        }
    }

    const visibleSavingsLine = formatVisibleSavingsLine(result.output_telemetry, {
        label: 'full-suite-validation'
    });
    if (visibleSavingsLine) {
        lines.push(visibleSavingsLine);
    }

    return lines;
}

export function buildFullSuiteValidationOutputTelemetry(
    rawOutputLines: string[],
    result: FullSuiteValidationResult
): Record<string, unknown> | null {
    if (rawOutputLines.length === 0) {
        return null;
    }

    let telemetry: Record<string, unknown> | null = null;
    let previousVisibleLine: string | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const filteredLines = buildFullSuiteValidationOutputLines({
            ...result,
            output_telemetry: telemetry
        });
        const nextTelemetry = buildOutputTelemetry(
            rawOutputLines,
            filteredLines,
            {
                filterMode: 'full_suite_validation_compaction',
                parserMode: 'FULL',
                parserName: 'full-suite-validation',
                parserStrategy: result.failure_chunks.length > 0 ? 'failure_chunks' : 'compact_summary'
            }
        );
        const nextVisibleLine = formatVisibleSavingsLine(nextTelemetry, {
            label: 'full-suite-validation'
        });
        telemetry = nextTelemetry;
        if (nextVisibleLine === previousVisibleLine) {
            break;
        }
        previousVisibleLine = nextVisibleLine;
    }

    return telemetry;
}

export function formatFullSuiteValidationResult(result: FullSuiteValidationResult): string {
    return buildFullSuiteValidationOutputLines(result).join('\n');
}
