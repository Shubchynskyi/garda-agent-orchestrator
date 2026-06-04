import * as fs from 'node:fs';
import * as path from 'node:path';
import { type FullSuiteValidationPlacement } from '../../core/workflow-config';
import { collectOrderedTimelineEvents } from '../completion/completion-evidence';
import {
    loadFullSuiteValidationConfig,
    type FullSuiteValidationResult
} from '../full-suite/full-suite-validation';
import {
    getCycleBindingSnapshotFromPayload,
    normalizeTaskCycleScopeBinding,
    resolveTaskCycleBindingSnapshot,
    taskCycleScopeBindingsMatch,
    type TaskCycleBindingSnapshot
} from '../task-events-summary/task-events-summary';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath,
    toStringArray
} from '../shared/helpers';

export interface ReviewContextFullSuiteValidationEvidence {
    review_type: string;
    required_for_review: boolean;
    placement: FullSuiteValidationPlacement | null;
    artifact_path: string | null;
    artifact_sha256: string | null;
    artifact_freshness: string;
    available: boolean;
    status: FullSuiteValidationResult['status'] | null;
    enabled: boolean | null;
    command: string | null;
    exit_code: number | null;
    timed_out: boolean | null;
    duration_ms: number | null;
    duration_human: string | null;
    output_artifact_path: string | null;
    output_retention: Record<string, unknown> | null;
    compact_summary: string[];
    violations: string[];
    warnings: string[];
    cycle_binding: FullSuiteValidationResult['cycle_binding'] | null;
    matches_current_preflight: boolean | null;
    compile_gate_artifact_path: string | null;
    compile_gate_timestamp_utc: string | null;
    compile_gate_status: string | null;
    matches_current_compile_gate: boolean | null;
    cycle_binding_valid: boolean | null;
    mismatch_reason: string | null;
    parse_error?: string;
}

export interface CurrentCompileGateEvidence {
    artifact_path: string | null;
    artifact_timestamp_utc: string | null;
    timeline_timestamp_utc: string | null;
    status: string | null;
    cycle_binding: TaskCycleBindingSnapshot | null;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function normalizeFullSuiteValidationStatus(value: unknown): FullSuiteValidationResult['status'] | null {
    const text = String(value || '').trim().toUpperCase();
    if (text === 'PASSED' || text === 'FAILED' || text === 'WARNED' || text === 'SKIPPED') {
        return text;
    }
    return null;
}

function normalizeNullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizePositiveDurationMs(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.round(value);
}

function formatDurationMsForReviewContext(durationMs: number | null): string | null {
    if (durationMs == null) {
        return null;
    }
    if (durationMs < 1000) {
        return `${durationMs} ms`;
    }
    const trimSeconds = (seconds: number): string => seconds.toFixed(1).replace(/\.0$/, '');
    const totalSeconds = durationMs / 1000;
    if (totalSeconds < 60) {
        return `${trimSeconds(totalSeconds)}s`;
    }
    const totalMinutes = Math.floor(totalSeconds / 60);
    const remainingSeconds = totalSeconds - totalMinutes * 60;
    if (totalMinutes < 60) {
        return `${totalMinutes}m ${trimSeconds(remainingSeconds)}s`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m ${trimSeconds(remainingSeconds)}s`;
}

function normalizeNullableBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function normalizeNullablePath(value: unknown): string | null {
    const text = String(value || '').trim();
    return text ? normalizePath(text) : null;
}

export function readCurrentCompileGateEvidence(repoRoot: string, taskId: string | null): CurrentCompileGateEvidence {
    if (!taskId) {
        return {
            artifact_path: null,
            artifact_timestamp_utc: null,
            timeline_timestamp_utc: null,
            status: null,
            cycle_binding: null
        };
    }
    const compileGateArtifactPath = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-compile-gate.json`));
    const normalizedArtifactPath = normalizePath(compileGateArtifactPath);
    const timelinePath = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineErrors: string[] = [];
    const timelineEvents = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    const latestCompileGatePassedTimestamp = [...timelineEvents]
        .reverse()
        .find((entry) => entry.event_type === 'COMPILE_GATE_PASSED')
        ?.timestamp_utc || null;
    const currentCycle = resolveTaskCycleBindingSnapshot(
        taskId,
        timelineEvents as unknown as ReadonlyArray<Record<string, unknown>>,
        repoRoot,
        path.dirname(compileGateArtifactPath)
    );
    if (!fs.existsSync(compileGateArtifactPath) || !fs.statSync(compileGateArtifactPath).isFile()) {
        return {
            artifact_path: normalizedArtifactPath,
            artifact_timestamp_utc: null,
            timeline_timestamp_utc: latestCompileGatePassedTimestamp,
            status: null,
            cycle_binding: currentCycle
        };
    }
    try {
        const raw = asPlainRecord(JSON.parse(fs.readFileSync(compileGateArtifactPath, 'utf8'))) || {};
        return {
            artifact_path: normalizedArtifactPath,
            artifact_timestamp_utc: String(raw.timestamp_utc || '').trim() || null,
            timeline_timestamp_utc: latestCompileGatePassedTimestamp,
            status: String(raw.status || '').trim() || null,
            cycle_binding: currentCycle || {
                preflight_path: normalizeNullablePath(raw.preflight_path),
                preflight_sha256: typeof raw.preflight_hash_sha256 === 'string' ? raw.preflight_hash_sha256 : null,
                compile_gate_timestamp: latestCompileGatePassedTimestamp,
                scope_binding: normalizeTaskCycleScopeBinding(raw)
            }
        };
    } catch {
        return {
            artifact_path: normalizedArtifactPath,
            artifact_timestamp_utc: null,
            timeline_timestamp_utc: latestCompileGatePassedTimestamp,
            status: null,
            cycle_binding: currentCycle
        };
    }
}

export function buildFullSuiteValidationEvidence(options: {
    repoRoot: string;
    taskId: string | null;
    reviewType: string;
    preflightPath: string;
    preflightSha256: string | null;
}): ReviewContextFullSuiteValidationEvidence | null {
    const fullSuiteValidationConfig = loadFullSuiteValidationConfig(options.repoRoot);
    const shouldRenderEvidence = fullSuiteValidationConfig.enabled === true || options.reviewType === 'test';
    if (!shouldRenderEvidence) {
        return null;
    }
    const requiredForReview = fullSuiteValidationConfig.enabled === true
        && (
            fullSuiteValidationConfig.placement === 'after_compile_before_reviews'
            || (
                fullSuiteValidationConfig.placement === 'before_test_review'
                && options.reviewType === 'test'
            )
        );

    const compileGateEvidence = readCurrentCompileGateEvidence(options.repoRoot, options.taskId);
    const artifactPath = options.taskId
        ? joinOrchestratorPath(options.repoRoot, path.join('runtime', 'reviews', `${options.taskId}-full-suite-validation.json`))
        : null;
    if (!artifactPath) {
        return {
            review_type: options.reviewType,
            required_for_review: requiredForReview,
            placement: fullSuiteValidationConfig.placement,
            artifact_path: null,
            artifact_sha256: null,
            artifact_freshness: requiredForReview ? 'missing' : 'not_required_for_review',
            available: false,
            status: null,
            enabled: fullSuiteValidationConfig.enabled,
            command: fullSuiteValidationConfig.command,
            exit_code: null,
            timed_out: null,
            duration_ms: null,
            duration_human: null,
            output_artifact_path: null,
            output_retention: null,
            compact_summary: [],
            violations: [],
            warnings: [],
            cycle_binding: null,
            matches_current_preflight: null,
            compile_gate_artifact_path: compileGateEvidence.artifact_path,
            compile_gate_timestamp_utc: compileGateEvidence.timeline_timestamp_utc,
            compile_gate_status: compileGateEvidence.status,
            matches_current_compile_gate: null,
            cycle_binding_valid: null,
            mismatch_reason: requiredForReview
                ? 'Task id is unavailable, so full-suite validation evidence cannot be resolved.'
                : null
        };
    }

    const normalizedArtifactPath = normalizePath(artifactPath);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return {
            review_type: options.reviewType,
            required_for_review: requiredForReview,
            placement: fullSuiteValidationConfig.placement,
            artifact_path: normalizedArtifactPath,
            artifact_sha256: null,
            artifact_freshness: requiredForReview ? 'missing' : 'not_required_for_review',
            available: false,
            status: null,
            enabled: fullSuiteValidationConfig.enabled,
            command: fullSuiteValidationConfig.command,
            exit_code: null,
            timed_out: null,
            duration_ms: null,
            duration_human: null,
            output_artifact_path: null,
            output_retention: null,
            compact_summary: [],
            violations: [],
            warnings: [],
            cycle_binding: null,
            matches_current_preflight: null,
            compile_gate_artifact_path: compileGateEvidence.artifact_path,
            compile_gate_timestamp_utc: compileGateEvidence.timeline_timestamp_utc,
            compile_gate_status: compileGateEvidence.status,
            matches_current_compile_gate: null,
            cycle_binding_valid: null,
            mismatch_reason: requiredForReview
                ? 'Full-suite validation evidence artifact is missing.'
                : null
        };
    }

    try {
        const raw = asPlainRecord(JSON.parse(fs.readFileSync(artifactPath, 'utf8'))) || {};
        const cycleBinding = asPlainRecord(raw.cycle_binding) as FullSuiteValidationResult['cycle_binding'] | null;
        let matchesCurrentPreflight: boolean | null = null;
        let matchesCurrentCompileGate: boolean | null = null;
        let cycleBindingValid: boolean | null = null;
        let mismatchReason: string | null = null;
        if (cycleBinding) {
            const expectedPreflightPath = normalizePath(options.preflightPath);
            const actualPreflightPath = normalizeNullablePath(cycleBinding.preflight_path);
            const actualPreflightSha256 = String(cycleBinding.preflight_sha256 || '').trim().toLowerCase();
            const actualTaskId = String(cycleBinding.task_id || '').trim();
            const actualCompileGateTimestamp = cycleBinding.compile_gate_timestamp == null
                ? null
                : String(cycleBinding.compile_gate_timestamp || '').trim() || null;
            const currentCycle = compileGateEvidence.cycle_binding;
            const candidateCycle = getCycleBindingSnapshotFromPayload({ cycle_binding: cycleBinding }, options.repoRoot);
            const sameScopeBinding = taskCycleScopeBindingsMatch(currentCycle, candidateCycle);
            matchesCurrentPreflight = actualPreflightPath === expectedPreflightPath
                && !!actualPreflightSha256
                && actualPreflightSha256 === String(options.preflightSha256 || '').trim().toLowerCase();
            matchesCurrentCompileGate = !!compileGateEvidence.timeline_timestamp_utc
                && actualCompileGateTimestamp === compileGateEvidence.timeline_timestamp_utc;
            cycleBindingValid = actualTaskId === String(options.taskId || '').trim()
                && (
                    (matchesCurrentPreflight === true && matchesCurrentCompileGate === true)
                    || (
                        sameScopeBinding === true
                        && actualPreflightPath === expectedPreflightPath
                    )
                );
            const mismatchReasons: string[] = [];
            if (actualTaskId !== String(options.taskId || '').trim()) {
                mismatchReasons.push('task id');
            }
            if (!matchesCurrentPreflight && !cycleBindingValid) {
                mismatchReasons.push('preflight artifact');
            }
            if (!matchesCurrentCompileGate && !cycleBindingValid) {
                mismatchReasons.push('compile gate cycle');
            }
            if (mismatchReasons.length > 0) {
                mismatchReason = `Full-suite validation cycle binding does not match the current ${mismatchReasons.join(', ')}.`;
            }
        } else {
            matchesCurrentPreflight = false;
            matchesCurrentCompileGate = false;
            cycleBindingValid = false;
            mismatchReason = 'Full-suite validation artifact is missing cycle_binding.';
        }

        const artifactFreshness = cycleBindingValid === true
            ? 'current'
            : cycleBindingValid === false
                ? 'stale'
                : 'unknown';
        const durationMs = normalizePositiveDurationMs(raw.duration_ms);
        return {
            review_type: options.reviewType,
            required_for_review: requiredForReview,
            placement: fullSuiteValidationConfig.placement,
            artifact_path: normalizedArtifactPath,
            artifact_sha256: fileSha256(artifactPath),
            artifact_freshness: artifactFreshness,
            available: true,
            status: normalizeFullSuiteValidationStatus(raw.status),
            enabled: normalizeNullableBoolean(raw.enabled),
            command: typeof raw.command === 'string' ? raw.command : null,
            exit_code: normalizeNullableNumber(raw.exit_code),
            timed_out: normalizeNullableBoolean(raw.timed_out),
            duration_ms: durationMs,
            duration_human: formatDurationMsForReviewContext(durationMs),
            output_artifact_path: normalizeNullablePath(raw.output_artifact_path),
            output_retention: asPlainRecord(raw.output_retention),
            compact_summary: toStringArray(raw.compact_summary, { trimValues: true }),
            violations: toStringArray(raw.violations, { trimValues: true }),
            warnings: toStringArray(raw.warnings, { trimValues: true }),
            cycle_binding: cycleBinding,
            matches_current_preflight: matchesCurrentPreflight,
            compile_gate_artifact_path: compileGateEvidence.artifact_path,
            compile_gate_timestamp_utc: compileGateEvidence.timeline_timestamp_utc,
            compile_gate_status: compileGateEvidence.status,
            matches_current_compile_gate: matchesCurrentCompileGate,
            cycle_binding_valid: cycleBindingValid,
            mismatch_reason: requiredForReview ? mismatchReason : null
        };
    } catch (error) {
        return {
            review_type: options.reviewType,
            required_for_review: requiredForReview,
            placement: fullSuiteValidationConfig.placement,
            artifact_path: normalizedArtifactPath,
            artifact_sha256: fileSha256(artifactPath),
            artifact_freshness: 'unavailable',
            available: false,
            status: null,
            enabled: null,
            command: null,
            exit_code: null,
            timed_out: null,
            duration_ms: null,
            duration_human: null,
            output_artifact_path: null,
            output_retention: null,
            compact_summary: [],
            violations: [],
            warnings: [],
            cycle_binding: null,
            matches_current_preflight: null,
            compile_gate_artifact_path: compileGateEvidence.artifact_path,
            compile_gate_timestamp_utc: compileGateEvidence.timeline_timestamp_utc,
            compile_gate_status: compileGateEvidence.status,
            matches_current_compile_gate: null,
            cycle_binding_valid: null,
            mismatch_reason: requiredForReview
                ? 'Full-suite validation evidence artifact could not be parsed.'
                : null,
            parse_error: error instanceof Error ? error.message : String(error)
        };
    }
}

export function buildFullSuiteValidationEvidenceMarkdown(evidence: ReviewContextFullSuiteValidationEvidence): string[] {
    const lines = [
        '## Full-Suite Validation Evidence',
        `- Required before this review: ${evidence.required_for_review ? 'yes' : 'no'}`,
        `- Placement: ${evidence.placement || 'unknown'}`,
        `- Evidence artifact: ${evidence.artifact_path || 'unavailable'}`,
        `- Evidence sha256: ${evidence.artifact_sha256 || 'unavailable'}`,
        `- Artifact freshness: ${evidence.artifact_freshness}`,
        `- Status: ${evidence.status || 'unavailable'}`,
        `- Enabled: ${evidence.enabled == null ? 'unknown' : String(evidence.enabled)}`,
        `- Command: ${evidence.command || 'unavailable'}`,
        `- Exit code: ${evidence.exit_code == null ? 'unknown' : String(evidence.exit_code)}`,
        `- Timed out: ${evidence.timed_out == null ? 'unknown' : String(evidence.timed_out)}`,
        `- Duration: ${evidence.duration_human || 'unavailable'}${evidence.duration_ms == null ? '' : ` (${evidence.duration_ms} ms)`}`,
        `- Output artifact: ${evidence.output_artifact_path
            || (evidence.output_retention?.raw_output_retained === false
                ? 'intentionally omitted for clean success retention policy'
                : 'unavailable')}`,
        `- Matches current preflight: ${evidence.matches_current_preflight == null ? 'unknown' : String(evidence.matches_current_preflight)}`,
        `- Compile gate artifact: ${evidence.compile_gate_artifact_path || 'unavailable'}`,
        `- Compile gate timestamp: ${evidence.compile_gate_timestamp_utc || 'unavailable'}`,
        `- Compile gate status: ${evidence.compile_gate_status || 'unavailable'}`,
        `- Matches current compile gate: ${evidence.matches_current_compile_gate == null ? 'unknown' : String(evidence.matches_current_compile_gate)}`,
        `- Cycle binding valid: ${evidence.cycle_binding_valid == null ? 'unknown' : String(evidence.cycle_binding_valid)}`
    ];
    if (
        evidence.required_for_review === true
        && evidence.status === 'PASSED'
        && evidence.cycle_binding_valid === true
    ) {
        lines.push('- Reviewer instruction: current PASS full-suite evidence already covers this review; do not rerun full tests unless investigating a concrete finding.');
    }
    if (
        evidence.enabled === true
        && evidence.required_for_review === false
        && evidence.placement === 'before_test_review'
    ) {
        lines.push(`- Reviewer note: before_test_review placement reserves full-suite evidence for the test review; this ${evidence.review_type} review must not demand pre-review full-suite evidence.`);
    }
    if (
        evidence.enabled === true
        && evidence.required_for_review === false
        && evidence.placement === 'before_completion'
    ) {
        lines.push('- Reviewer note: before_completion placement does not require pre-review full-suite evidence; do not demand a suite rerun for this review because completion still enforces full-suite validation later.');
    }
    if (evidence.mismatch_reason) {
        lines.push(`- Mismatch reason: ${evidence.mismatch_reason}`);
    }
    lines.push('- Compact summary:');
    if (evidence.compact_summary.length === 0) {
        lines.push('  - none');
    } else {
        for (const summaryLine of evidence.compact_summary) {
            lines.push(`  - ${summaryLine}`);
        }
    }
    if (evidence.output_retention) {
        lines.push(
            `- Output retention: retained=${String(evidence.output_retention.raw_output_retained)}; `
            + `reason=${String(evidence.output_retention.retention_reason || 'unknown')}; `
            + `sha256=${String(evidence.output_retention.raw_output_sha256 || 'null')}; `
            + `lines=${String(evidence.output_retention.raw_output_line_count || 0)}; `
            + `chars=${String(evidence.output_retention.raw_output_char_count || 0)}`
        );
    }
    if (evidence.violations.length > 0) {
        lines.push('- Violations:');
        for (const violation of evidence.violations) {
            lines.push(`  - ${violation}`);
        }
    }
    if (evidence.warnings.length > 0) {
        lines.push('- Warnings:');
        for (const warning of evidence.warnings) {
            lines.push(`  - ${warning}`);
        }
    }
    return lines;
}
