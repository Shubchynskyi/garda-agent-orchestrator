import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../core/constants';
import { redactSecretText } from '../../core/redaction';
import { normalizeFullSuiteValidationPlacement } from '../../core/workflow-config';
import { joinOrchestratorPath, normalizePath } from '../shared/helpers';
import {
    OUT_OF_SCOPE_FAILURE_POLICIES,
    type FullSuiteDurationHistory,
    type FullSuiteDurationHistoryEntry,
    type FullSuitePerformanceGuidance,
    type FullSuiteTimeoutForecast,
    type FullSuiteValidationConfig,
    type OutOfScopeFailurePolicy
} from './full-suite-validation-types';

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
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

function commandIncludesShardMode(command: string): boolean {
    return /\btest:sharded\b/i.test(command) || /--garda-shards(?:\s+|=)\d+/i.test(command);
}

function commandIncludesReuseAwareMode(command: string): boolean {
    return /\bbuild-prep\b/i.test(command)
        || /\breuse\b/i.test(command)
        || /\bNODE_FOUNDATION_BUILD_REUSE\b/i.test(command)
        || /\bPUBLISH_RUNTIME_BUILD_REUSE\b/i.test(command)
        || /\bSCRIPTS_BUILD_REUSE\b/i.test(command);
}

export function buildFullSuitePerformanceGuidance(command: string): FullSuitePerformanceGuidance {
    const trimmedCommand = redactSecretText(String(command || '').trim());
    const sharded = commandIncludesShardMode(trimmedCommand);
    const reuseAware = commandIncludesReuseAwareMode(trimmedCommand);
    const mode = sharded && reuseAware
        ? 'optimized_sharded_reuse_aware'
        : sharded
            ? 'optimized_sharded'
            : reuseAware
                ? 'optimized_reuse_aware'
                : 'standard';
    return {
        mode,
        optimized: mode !== 'standard',
        mandatory_boundary: 'mandatory full-suite evidence; not a smoke, fast, or release-smoke substitute',
        optimized_command: mode !== 'standard' && trimmedCommand ? trimmedCommand : null,
        fallback_command: trimmedCommand && trimmedCommand !== 'npm test' ? 'npm test' : null
    };
}

export function formatFullSuitePerformanceGuidance(command: string): string {
    const guidance = buildFullSuitePerformanceGuidance(command);
    const parts = [
        `mode=${guidance.mode}`,
        `optimized=${String(guidance.optimized)}`,
        'boundary=mandatory_full_suite_not_smoke_or_fast'
    ];
    if (guidance.optimized_command) {
        parts.push(`optimized_command="${guidance.optimized_command}"`);
    }
    if (guidance.fallback_command) {
        parts.push(`fallback_command="${guidance.fallback_command}"`);
    }
    return parts.join('; ');
}
