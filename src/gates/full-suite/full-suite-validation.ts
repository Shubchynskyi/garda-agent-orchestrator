import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../core/constants';
import { redactSecretText } from '../../core/redaction';
import {
    normalizeFullSuiteValidationPlacement,
    type FullSuiteValidationPlacement
} from '../../core/workflow-config';
import { buildOutputTelemetry, formatVisibleSavingsLine } from '../../gate-runtime/token-telemetry';
import type { RawOutputRetentionEvidence } from '../../gate-runtime/output-log-retention';
import { joinOrchestratorPath, normalizePath } from '../shared/helpers';

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

export const FULL_SUITE_DURATION_HISTORY_LIMIT = 5;
export const FULL_SUITE_TIMEOUT_MARGIN_RATIO = 0.2;
export const FULL_SUITE_TIMEOUT_MIN_MARGIN_SECONDS = 30;

const DEFAULT_CONFIG: FullSuiteValidationConfig = Object.freeze({
    enabled: false,
    command: UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
    timeout_ms: 600_000,
    green_summary_max_lines: 5,
    red_failure_chunk_lines: 50,
    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
    placement: 'after_compile_before_reviews'
});

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
}

export function resolveWorkflowConfigPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('live', 'config', 'workflow-config.json'));
}

export function loadFullSuiteValidationConfig(repoRoot: string): FullSuiteValidationConfig {
    const configPath = resolveWorkflowConfigPath(repoRoot);
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        return { ...DEFAULT_CONFIG };
    }

    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        return { ...DEFAULT_CONFIG };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ...DEFAULT_CONFIG };
    }
    const config = raw as Record<string, unknown>;
    const section = config.full_suite_validation;
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
        out_of_scope_failure_policy: normalizeOutOfScopePolicy(record.out_of_scope_failure_policy),
        placement: normalizeFullSuiteValidationPlacement(record.placement, {
            rejectInvalidExplicit: true,
            errorPath: 'workflow-config.full_suite_validation.placement'
        })
    };
}

function normalizeOutOfScopePolicy(value: unknown): OutOfScopeFailurePolicy {
    const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (OUT_OF_SCOPE_FAILURE_POLICIES.includes(normalized as OutOfScopeFailurePolicy)) {
        return normalized as OutOfScopeFailurePolicy;
    }
    return 'AUDIT_AND_BLOCK';
}

export function resolveFullSuiteDurationHistoryPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'metrics', 'full-suite-validation-duration-history.json'));
}

export function buildFullSuiteConfigSignature(config: FullSuiteValidationConfig): string {
    const relevantConfig = {
        command: config.command,
        timeout_ms: config.timeout_ms,
        green_summary_max_lines: config.green_summary_max_lines,
        red_failure_chunk_lines: config.red_failure_chunk_lines,
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        placement: config.placement
    };
    return createHash('sha256').update(JSON.stringify(relevantConfig)).digest('hex');
}

function isFullSuiteDurationHistoryEntry(value: unknown): value is FullSuiteDurationHistoryEntry {
    if (!isPlainRecord(value)) {
        return false;
    }
    return typeof value.timestamp_utc === 'string'
        && typeof value.task_id === 'string'
        && ['PASSED', 'FAILED', 'WARNED'].includes(String(value.status))
        && typeof value.command === 'string'
        && typeof value.config_signature_sha256 === 'string'
        && typeof value.duration_ms === 'number'
        && Number.isFinite(value.duration_ms)
        && value.duration_ms > 0
        && typeof value.timed_out === 'boolean'
        && (typeof value.exit_code === 'number' || value.exit_code === null);
}

export function readFullSuiteDurationHistory(repoRoot: string): {
    history: FullSuiteDurationHistory;
    warning: string | null;
} {
    const historyPath = resolveFullSuiteDurationHistoryPath(repoRoot);
    const emptyHistory: FullSuiteDurationHistory = {
        schema_version: 1,
        history_limit: FULL_SUITE_DURATION_HISTORY_LIMIT,
        updated_at_utc: new Date(0).toISOString(),
        entries: []
    };
    if (!fs.existsSync(historyPath)) {
        return { history: emptyHistory, warning: null };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed) || !Array.isArray(parsed.entries)) {
            return {
                history: emptyHistory,
                warning: `Full-suite duration history at ${normalizePath(historyPath)} is malformed; using configured timeout fallback.`
            };
        }
        return {
            history: {
                schema_version: 1,
                history_limit: FULL_SUITE_DURATION_HISTORY_LIMIT,
                updated_at_utc: typeof parsed.updated_at_utc === 'string'
                    ? parsed.updated_at_utc
                    : new Date(0).toISOString(),
                entries: parsed.entries.filter(isFullSuiteDurationHistoryEntry).slice(-FULL_SUITE_DURATION_HISTORY_LIMIT)
            },
            warning: null
        };
    } catch {
        return {
            history: emptyHistory,
            warning: `Full-suite duration history at ${normalizePath(historyPath)} is unreadable; using configured timeout fallback.`
        };
    }
}

export function recordFullSuiteValidationDuration(
    repoRoot: string,
    config: FullSuiteValidationConfig,
    entry: Omit<FullSuiteDurationHistoryEntry, 'command' | 'config_signature_sha256'>
): FullSuiteDurationHistory {
    const historyPath = resolveFullSuiteDurationHistoryPath(repoRoot);
    const signature = buildFullSuiteConfigSignature(config);
    const { history } = readFullSuiteDurationHistory(repoRoot);
    const entries = [
        ...history.entries.filter((candidate) => candidate.config_signature_sha256 === signature),
        {
            ...entry,
            command: redactSecretText(config.command),
            config_signature_sha256: signature
        }
    ].slice(-FULL_SUITE_DURATION_HISTORY_LIMIT);
    const nextHistory: FullSuiteDurationHistory = {
        schema_version: 1,
        history_limit: FULL_SUITE_DURATION_HISTORY_LIMIT,
        updated_at_utc: new Date().toISOString(),
        entries
    };
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, `${JSON.stringify(nextHistory, null, 2)}\n`, 'utf8');
    return nextHistory;
}

export function buildFullSuiteTimeoutForecast(
    repoRoot: string,
    config: FullSuiteValidationConfig
): FullSuiteTimeoutForecast {
    const historyPath = resolveFullSuiteDurationHistoryPath(repoRoot);
    const signature = buildFullSuiteConfigSignature(config);
    const { history, warning } = readFullSuiteDurationHistory(repoRoot);
    const samples = history.entries
        .filter((entry) => entry.config_signature_sha256 === signature)
        .filter((entry) => Number.isFinite(entry.duration_ms) && entry.duration_ms > 0)
        .slice(-FULL_SUITE_DURATION_HISTORY_LIMIT);
    const configuredTimeoutSeconds = Math.ceil(config.timeout_ms / 1000);
    if (samples.length === 0) {
        return {
            history_path: normalizePath(historyPath),
            sample_count: 0,
            average_duration_seconds: null,
            high_watermark_duration_seconds: null,
            recommended_timeout_seconds: configuredTimeoutSeconds,
            safety_margin_seconds: null,
            recommendation_source: 'config_timeout',
            configured_timeout_seconds: configuredTimeoutSeconds,
            warning
        };
    }

    const averageDurationSeconds = samples.reduce((total, entry) => total + entry.duration_ms / 1000, 0) / samples.length;
    const highWatermarkDurationSeconds = Math.max(...samples.map((entry) => entry.duration_ms / 1000));
    const recommendedTimeoutSeconds = Math.ceil(Math.max(
        averageDurationSeconds * (1 + FULL_SUITE_TIMEOUT_MARGIN_RATIO),
        averageDurationSeconds + FULL_SUITE_TIMEOUT_MIN_MARGIN_SECONDS,
        highWatermarkDurationSeconds * (1 + FULL_SUITE_TIMEOUT_MARGIN_RATIO),
        highWatermarkDurationSeconds + FULL_SUITE_TIMEOUT_MIN_MARGIN_SECONDS
    ));
    return {
        history_path: normalizePath(historyPath),
        sample_count: samples.length,
        average_duration_seconds: Math.round(averageDurationSeconds * 10) / 10,
        high_watermark_duration_seconds: Math.round(highWatermarkDurationSeconds * 10) / 10,
        recommended_timeout_seconds: recommendedTimeoutSeconds,
        safety_margin_seconds: Math.round((recommendedTimeoutSeconds - highWatermarkDurationSeconds) * 10) / 10,
        recommendation_source: 'history',
        configured_timeout_seconds: configuredTimeoutSeconds,
        warning
    };
}

export function formatFullSuiteTimeoutForecast(forecast: FullSuiteTimeoutForecast): string {
    if (forecast.recommendation_source === 'history' && forecast.average_duration_seconds !== null) {
        return `Recommended full-suite command timeout: ${forecast.recommended_timeout_seconds}s `
            + `(last ${forecast.sample_count} run(s) avg ${forecast.average_duration_seconds}s; `
            + `max ${forecast.high_watermark_duration_seconds}s; `
            + `safety margin over max +${forecast.safety_margin_seconds}s = 20% but at least 30s).`;
    }
    const suffix = forecast.warning ? ` ${forecast.warning}` : '';
    return `Recommended full-suite command timeout: ${forecast.recommended_timeout_seconds}s `
        + `(no recent matching full-suite duration history; using configured timeout).${suffix}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasTrueFlag(record: Record<string, unknown>, key: string): boolean {
    return record[key] === true;
}

function hasRequiredReview(preflight: Record<string, unknown>): boolean {
    const requiredReviews = isPlainRecord(preflight.required_reviews) ? preflight.required_reviews : {};
    return Object.values(requiredReviews).some((value) => value === true);
}

export function isFullSuiteNotRequiredForDocsOnlyScope(preflight: Record<string, unknown>): boolean {
    const scopeCategory = String(preflight.scope_category || '').trim().toLowerCase();
    if (scopeCategory !== 'docs-only') {
        return false;
    }

    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    if (changedFiles.length === 0) {
        return false;
    }

    const triggers = isPlainRecord(preflight.triggers) ? preflight.triggers : {};
    const executionTriggers = [
        'runtime_code_changed',
        'test',
        'infra',
        'performance'
    ];
    if (executionTriggers.some((key) => hasTrueFlag(triggers, key))) {
        return false;
    }

    return true;
}

export function isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight: Record<string, unknown>): boolean {
    const zeroDiffGuard = isPlainRecord(preflight.zero_diff_guard) ? preflight.zero_diff_guard : {};
    const profileGuardrails = isPlainRecord(preflight.profile_guardrails) ? preflight.profile_guardrails : {};
    return zeroDiffGuard.zero_diff_detected === true
        && String(zeroDiffGuard.status || '').trim() === 'BASELINE_ONLY'
        && zeroDiffGuard.completion_requires_audited_no_op === true
        && profileGuardrails.zero_diff_no_reviewable_scope === true
        && !hasRequiredReview(preflight);
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
        required: false,
        skip_reason: 'CONFIG_DISABLED',
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

export function buildDocsOnlyNotRequiredResult(
    config: FullSuiteValidationConfig,
    cycleBinding?: FullSuiteValidationCycleBinding
): FullSuiteValidationResult {
    return {
        status: 'SKIPPED',
        enabled: config.enabled,
        command: config.command,
        required: false,
        skip_reason: 'DOCS_ONLY_SCOPE_NOT_REQUIRED',
        exit_code: null,
        timed_out: false,
        output_artifact_path: null,
        compact_summary: ['Full-suite validation is not required for this docs-only scope.'],
        failure_chunks: [],
        out_of_scope_failure_policy: config.out_of_scope_failure_policy,
        out_of_scope_failure_detected: false,
        out_of_scope_audit_verdict: 'NOT_APPLICABLE',
        violations: [],
        warnings: [],
        cycle_binding: cycleBinding
    };
}

export function buildZeroDiffNoReviewableNotRequiredResult(
    config: FullSuiteValidationConfig,
    cycleBinding?: FullSuiteValidationCycleBinding
): FullSuiteValidationResult {
    return {
        status: 'SKIPPED',
        enabled: config.enabled,
        command: config.command,
        required: false,
        skip_reason: 'ZERO_DIFF_NO_REVIEWABLE_SCOPE_NOT_REQUIRED',
        exit_code: null,
        timed_out: false,
        output_artifact_path: null,
        compact_summary: ['Full-suite validation is not required for this zero-diff no-reviewable scope.'],
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
    const harnessFailure = detectHarnessTimeoutFailure(outputLines, taskChangedFiles, timedOut);
    let auditVerdict: 'BLOCKED' | 'WARNED' | 'NOT_APPLICABLE' = 'NOT_APPLICABLE';
    if (outOfScopeDetected) {
        auditVerdict = harnessFailure.detected || config.out_of_scope_failure_policy === 'AUDIT_AND_WARN'
            ? 'WARNED'
            : 'BLOCKED';
    }

    const effectiveStatus: 'FAILED' | 'WARNED' =
        harnessFailure.detected
            ? 'WARNED'
            : outOfScopeDetected
            && config.out_of_scope_failure_policy === 'AUDIT_AND_WARN'
            && !timedOut
                ? 'WARNED'
                : 'FAILED';

    if (effectiveStatus === 'FAILED') {
        if (timedOut) {
            violations.push(`Full suite validation timed out after ${config.timeout_ms}ms.`);
        } else {
            violations.push(`Full suite validation failed with exit code ${exitCode}.`);
        }
        if (outOfScopeDetected && auditVerdict === 'BLOCKED') {
            violations.push(
                'Out-of-scope test failures detected. Policy AUDIT_AND_BLOCK requires resolution before DONE. ' +
                'Review the full output artifact for details.'
            );
        }
    } else {
        if (harnessFailure.detected) {
            warnings.push(
                'Full suite timed out in an out-of-scope test harness or lock surface. ' +
                'Recorded as WARNED so unrelated reviewed tasks are not blocked indefinitely. ' +
                'Review the full output artifact and fix the harness separately.'
            );
            warnings.push(`Harness failure reason: ${harnessFailure.reason}`);
            warnings.push(`Full suite exited with code ${exitCode} after timeout ${config.timeout_ms}ms.`);
        } else {
            warnings.push(
                'Out-of-scope test failures detected. Policy AUDIT_AND_WARN records the finding but does not block completion. ' +
                'Review the full output artifact for details.'
            );
            warnings.push(`Full suite exited with code ${exitCode} (non-blocking under AUDIT_AND_WARN).`);
        }
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
        harness_failure_detected: harnessFailure.detected,
        harness_failure_audit_verdict: harnessFailure.detected ? 'WARNED' : 'NOT_APPLICABLE',
        harness_failure_reason: harnessFailure.reason,
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
    const failureFileRefs = collectFailureFileRefs(outputLines);

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

function collectFailureFileRefs(outputLines: string[]): string[] {
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

    return failureFileRefs;
}

function failureRefMatchesChangedFile(ref: string, changedFiles: Set<string>): boolean {
    for (const changed of changedFiles) {
        if (ref.includes(changed) || changed.includes(ref)) {
            return true;
        }
    }
    return false;
}

function detectHarnessTimeoutFailure(
    outputLines: string[],
    taskChangedFiles: string[],
    timedOut: boolean
): { detected: boolean; reason: string | null; } {
    if (!timedOut || taskChangedFiles.length === 0) {
        return { detected: false, reason: null };
    }

    const joinedOutput = outputLines.join('\n');
    const hasHarnessSignal =
        /Process timed out after \d+ ms\./i.test(joinedOutput)
        && (
            /Timed out acquiring file lock:/i.test(joinedOutput)
            || /task-event append failed/i.test(joinedOutput)
            || /\.scripts-build\.lock|\.node-build\.lock|dist\.lock/i.test(joinedOutput)
            || /cli[\\/]+commands[\\/]+gates/i.test(joinedOutput)
        );
    if (!hasHarnessSignal) {
        return { detected: false, reason: null };
    }

    const failureFileRefs = collectFailureFileRefs(outputLines);
    if (failureFileRefs.length === 0) {
        return { detected: false, reason: null };
    }

    const changedSet = new Set(taskChangedFiles.map((filePath) => normalizePath(filePath)));
    const hasInScopeFailure = failureFileRefs.some((ref) => failureRefMatchesChangedFile(ref, changedSet));
    if (hasInScopeFailure) {
        return { detected: false, reason: null };
    }

    return {
        detected: true,
        reason: 'timeout_with_out_of_scope_lock_or_cli_gates_harness_failures'
    };
}

function buildFullSuiteValidationOutputLines(result: FullSuiteValidationResult): string[] {
    const lines: string[] = [];
    lines.push(`FULL_SUITE_VALIDATION_${result.status}`);
    lines.push(`Enabled: ${result.enabled}`);
    lines.push(`Command: ${redactSecretText(result.command)}`);
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
