import * as fs from 'node:fs';
import * as path from 'node:path';

import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../core/constants';
import { joinOrchestratorPath, normalizePath } from './helpers';

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
}

export interface FullSuiteValidationCycleBinding {
    task_id: string;
    preflight_path: string;
    preflight_sha256: string;
    compile_gate_timestamp: string | null;
}

const DEFAULT_CONFIG: FullSuiteValidationConfig = Object.freeze({
    enabled: false,
    command: UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
    timeout_ms: 600_000,
    green_summary_max_lines: 5,
    red_failure_chunk_lines: 50,
    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
});

export interface FullSuiteValidationResult {
    status: 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED';
    enabled: boolean;
    command: string;
    exit_code: number | null;
    timed_out: boolean;
    output_artifact_path: string | null;
    compact_summary: string[];
    failure_chunks: string[][];
    out_of_scope_failure_policy: OutOfScopeFailurePolicy;
    out_of_scope_failure_detected: boolean;
    out_of_scope_audit_verdict: 'BLOCKED' | 'WARNED' | 'NOT_APPLICABLE';
    violations: string[];
    warnings: string[];
    cycle_binding?: FullSuiteValidationCycleBinding;
}

export function resolveWorkflowConfigPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('live', 'config', 'workflow-config.json'));
}

export function loadFullSuiteValidationConfig(repoRoot: string): FullSuiteValidationConfig {
    const configPath = resolveWorkflowConfigPath(repoRoot);
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        return { ...DEFAULT_CONFIG };
    }

    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        const section = raw.full_suite_validation;
        if (!section || typeof section !== 'object' || Array.isArray(section)) {
            return { ...DEFAULT_CONFIG };
        }
        const record = section as Record<string, unknown>;
        return {
            enabled: record.enabled === true,
            command: typeof record.command === 'string' && record.command.trim()
                ? record.command.trim()
                : DEFAULT_CONFIG.command,
            timeout_ms: typeof record.timeout_ms === 'number' && record.timeout_ms > 0
                ? record.timeout_ms
                : DEFAULT_CONFIG.timeout_ms,
            green_summary_max_lines: typeof record.green_summary_max_lines === 'number' && record.green_summary_max_lines > 0
                ? record.green_summary_max_lines
                : DEFAULT_CONFIG.green_summary_max_lines,
            red_failure_chunk_lines: typeof record.red_failure_chunk_lines === 'number' && record.red_failure_chunk_lines > 0
                ? record.red_failure_chunk_lines
                : DEFAULT_CONFIG.red_failure_chunk_lines,
            out_of_scope_failure_policy: normalizeOutOfScopePolicy(record.out_of_scope_failure_policy)
        };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

function normalizeOutOfScopePolicy(value: unknown): OutOfScopeFailurePolicy {
    const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (OUT_OF_SCOPE_FAILURE_POLICIES.includes(normalized as OutOfScopeFailurePolicy)) {
        return normalized as OutOfScopeFailurePolicy;
    }
    return 'AUDIT_AND_BLOCK';
}

export function compactGreenSummary(outputLines: string[], maxLines: number): string[] {
    if (outputLines.length === 0) {
        return ['Full suite passed (no output).'];
    }

    const summaryLines: string[] = [];
    const nodeTestPass = extractMetricLine(outputLines, /^#\s*(pass|tests)\s+\d+/i);
    if (nodeTestPass) {
        summaryLines.push(nodeTestPass);
        const nodeTestFail = extractMetricLine(outputLines, /^#\s*fail\s+\d+/i);
        if (nodeTestFail) summaryLines.push(nodeTestFail);
        const nodeTestDuration = extractMetricLine(outputLines, /^#\s*duration_ms\s/i);
        if (nodeTestDuration) summaryLines.push(nodeTestDuration);
        return summaryLines.slice(0, maxLines);
    }

    const totalTests = extractMetricLine(outputLines, /tests?\s+(\d+)\s+(passed|pass)/i)
        || extractMetricLine(outputLines, /(\d+)\s+passing/i)
        || extractTailSummary(outputLines);
    if (totalTests) {
        summaryLines.push(totalTests);
    }

    const durationLine = extractMetricLine(outputLines, /duration|time|elapsed|took/i);
    if (durationLine && durationLine !== totalTests) {
        summaryLines.push(durationLine);
    }

    if (summaryLines.length === 0) {
        return outputLines.slice(-Math.min(maxLines, outputLines.length));
    }

    return summaryLines.slice(0, maxLines);
}

function extractMetricLine(lines: string[], pattern: RegExp): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (pattern.test(lines[index])) {
            return lines[index].trim();
        }
    }
    return null;
}

function extractTailSummary(lines: string[]): string | null {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const stripped = lines[index].trim();
        if (stripped) {
            return stripped;
        }
    }
    return null;
}

export function compactRedFailureChunks(outputLines: string[], chunkLines: number): string[][] {
    if (outputLines.length === 0) {
        return [['Full suite failed (no output captured).']];
    }

    const failureIndices: number[] = [];
    for (let index = 0; index < outputLines.length; index += 1) {
        const line = outputLines[index];
        if (/\bfail(ed|ure|ing)?\b/i.test(line) || /\berror\b/i.test(line) || /\bnot ok\b/i.test(line)) {
            failureIndices.push(index);
        }
    }

    if (failureIndices.length === 0) {
        return [outputLines.slice(-chunkLines)];
    }

    const chunks: string[][] = [];
    const contextBefore = Math.max(2, Math.floor(chunkLines * 0.2));
    const contextAfter = chunkLines - contextBefore;
    const usedLines = new Set<number>();

    for (const failIndex of failureIndices) {
        const start = Math.max(0, failIndex - contextBefore);
        const end = Math.min(outputLines.length, failIndex + contextAfter);
        const chunk: string[] = [];

        for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
            if (!usedLines.has(lineIndex)) {
                chunk.push(outputLines[lineIndex]);
                usedLines.add(lineIndex);
            }
        }

        if (chunk.length > 0) {
            chunks.push(chunk);
        }

        if (chunks.length >= 3) {
            break;
        }
    }

    if (chunks.length === 0) {
        chunks.push(outputLines.slice(-chunkLines));
    }

    return chunks;
}

export function buildSkippedResult(
    config: FullSuiteValidationConfig,
    cycleBinding?: FullSuiteValidationCycleBinding
): FullSuiteValidationResult {
    return {
        status: 'SKIPPED',
        enabled: false,
        command: config.command,
        exit_code: null,
        timed_out: false,
        output_artifact_path: null,
        compact_summary: ['Full-suite validation is disabled.'],
        failure_chunks: [],
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: false,
        out_of_scope_audit_verdict: 'NOT_APPLICABLE',
        violations: [],
        warnings: [],
        cycle_binding: cycleBinding
    };
}

export function buildValidationResult(
    config: FullSuiteValidationConfig,
    exitCode: number,
    timedOut: boolean,
    outputLines: string[],
    outputArtifactPath: string | null,
    taskChangedFiles: string[],
    cycleBinding?: FullSuiteValidationCycleBinding
): FullSuiteValidationResult {
    const passed = exitCode === 0 && !timedOut;
    const violations: string[] = [];
    const warnings: string[] = [];

    if (timedOut) {
        violations.push(`Full suite validation timed out after ${config.timeout_ms}ms.`);
    }

    if (passed) {
        return {
            status: 'PASSED',
            enabled: true,
            command: config.command,
            exit_code: exitCode,
            timed_out: false,
            output_artifact_path: outputArtifactPath ? normalizePath(outputArtifactPath) : null,
            compact_summary: compactGreenSummary(outputLines, config.green_summary_max_lines),
            failure_chunks: [],
            out_of_scope_failure_policy: config.out_of_scope_failure_policy,
            out_of_scope_failure_detected: false,
            out_of_scope_audit_verdict: 'NOT_APPLICABLE',
            violations: [],
            warnings: [],
            cycle_binding: cycleBinding
        };
    }

    const failureChunks = compactRedFailureChunks(outputLines, config.red_failure_chunk_lines);
    const outOfScopeDetected = detectOutOfScopeFailures(outputLines, taskChangedFiles);
    let auditVerdict: 'BLOCKED' | 'WARNED' | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
    if (outOfScopeDetected) {
        auditVerdict = config.out_of_scope_failure_policy === 'AUDIT_AND_BLOCK' ? 'BLOCKED' : 'WARNED';
    }

    const effectiveStatus: 'FAILED' | 'WARNED' =
        outOfScopeDetected
            && config.out_of_scope_failure_policy === 'AUDIT_AND_WARN'
            && !timedOut
            ? 'WARNED'
            : 'FAILED';

    if (effectiveStatus === 'FAILED') {
        if (!timedOut) {
            violations.push(`Full suite validation failed with exit code ${exitCode}.`);
        }
        if (outOfScopeDetected && auditVerdict === 'BLOCKED') {
            violations.push(
                'Out-of-scope test failures detected. Policy AUDIT_AND_BLOCK requires resolution before DONE. ' +
                'Review the full output artifact for details.'
            );
        }
    } else {
        warnings.push(
            'Out-of-scope test failures detected. Policy AUDIT_AND_WARN records the finding but does not block completion. ' +
            'Review the full output artifact for details.'
        );
        warnings.push(`Full suite exited with code ${exitCode} (non-blocking under AUDIT_AND_WARN).`);
    }

    return {
        status: effectiveStatus,
        enabled: true,
        command: config.command,
        exit_code: exitCode,
        timed_out: timedOut,
        output_artifact_path: outputArtifactPath ? normalizePath(outputArtifactPath) : null,
        compact_summary: failureChunks.length > 0 ? failureChunks[0].slice(0, config.green_summary_max_lines) : [],
        failure_chunks: failureChunks,
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: outOfScopeDetected,
        out_of_scope_audit_verdict: auditVerdict,
        violations,
        warnings,
        cycle_binding: cycleBinding
    };
}

export function detectOutOfScopeFailures(outputLines: string[], taskChangedFiles: string[]): boolean {
    if (taskChangedFiles.length === 0) {
        return false;
    }

    const changedSet = new Set(taskChangedFiles.map((filePath) => normalizePath(filePath)));
    const failureFileRefs: string[] = [];

    for (const line of outputLines) {
        if (!/\bfail(ed|ure|ing)?\b/i.test(line) && !/\berror\b/i.test(line) && !/\bnot ok\b/i.test(line)) {
            continue;
        }
        const fileRefMatch = line.match(/(?:at\s+|in\s+|file\s+)?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z]{1,4})[\s:(\]]/);
        if (fileRefMatch) {
            failureFileRefs.push(normalizePath(fileRefMatch[1]));
        }
    }

    if (failureFileRefs.length === 0) {
        return false;
    }

    for (const ref of failureFileRefs) {
        const isInScope = [...changedSet].some((changed) => ref.includes(changed) || changed.includes(ref));
        if (!isInScope) {
            return true;
        }
    }

    return false;
}

export function formatFullSuiteValidationResult(result: FullSuiteValidationResult): string {
    const lines: string[] = [];
    lines.push(`FULL_SUITE_VALIDATION_${result.status}`);
    lines.push(`Enabled: ${result.enabled}`);
    lines.push(`Command: ${result.command}`);

    if (result.exit_code !== null) {
        lines.push(`ExitCode: ${result.exit_code}`);
    }
    if (result.timed_out) {
        lines.push('TimedOut: true');
    }
    if (result.output_artifact_path) {
        lines.push(`OutputArtifact: ${result.output_artifact_path}`);
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

    return lines.join('\n');
}
