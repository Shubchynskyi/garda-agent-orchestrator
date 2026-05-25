import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    CANONICAL_REVIEW_CONTEXT_TYPES,
    getGateOutputCompactionLabel,
    getReviewContextOutputLabel,
    summarizeOutputCompactionBreakdown
} from '../gate-runtime/output-compaction-reporting';
import {
    assertValidTaskId,
    inspectTaskEventFile,
    forEachJsonlLine,
    normalizeTaskEventPublicRecord,
    TASK_EVENT_LEGACY_SCHEMA_VERSION,
    TASK_EVENT_PUBLIC_SCHEMA_VERSION,
    type TaskEventHealthState,
    type TaskEventLifecyclePhase,
    type TaskEventTerminalOutcome
} from '../gate-runtime/task-events';
import { coerceIntLike } from '../gate-runtime/token-telemetry';
import { joinOrchestratorPath, resolvePathInsideRepo, toPosix } from './helpers';
import { formatTimestamp, parseTimestamp } from './task-events-summary-parsing';
import { getCommandAuditFromDetails } from './task-events-summary-noise';
function resolveArtifactPathForRead(pathValue: unknown, repoRoot: string | null): string | null {
    if (pathValue == null) {
        return null;
    }
    const text = String(pathValue).trim();
    if (!text) {
        return null;
    }
    if (repoRoot) {
        try {
            return resolvePathInsideRepo(text, repoRoot, { allowMissing: true });
        } catch {
            return null;
        }
    }
    if (path.isAbsolute(text)) {
        return path.resolve(text);
    }
    return null;
}

function readJsonArtifactForSummary(pathValue: unknown, repoRoot: string | null): { path: string; payload: Record<string, unknown> } | null {
    const resolvedPath = resolveArtifactPathForRead(pathValue, repoRoot);
    if (!resolvedPath) {
        return null;
    }
    try {
        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
            return null;
        }
        return {
            path: toPosix(resolvedPath),
            payload: JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
        };
    } catch {
        return null;
    }
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

export function getOutputTelemetryFromPayload(payload: Record<string, unknown> | null | undefined) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const candidate = (payload.output_telemetry && typeof payload.output_telemetry === 'object'
        ? payload.output_telemetry
        : payload) as Record<string, unknown>;
    const savedTokens = coerceIntLike(candidate.estimated_saved_tokens);
    const savedChars = coerceIntLike(candidate.estimated_saved_chars);
    if ((savedTokens == null || savedTokens <= 0) && (savedChars == null || savedChars <= 0)) {
        return null;
    }
    const rawTokenEstimate = coerceIntLike(candidate.raw_token_count_estimate);
    const outputTokenEstimate = coerceIntLike(candidate.filtered_token_count_estimate);
    const rawCharCount = coerceIntLike(candidate.raw_char_count);
    const outputCharCount = coerceIntLike(candidate.filtered_char_count);
    return {
        raw_token_count_estimate: rawTokenEstimate != null && rawTokenEstimate > 0 ? rawTokenEstimate : 0,
        output_token_count_estimate: outputTokenEstimate != null && outputTokenEstimate >= 0 ? outputTokenEstimate : null,
        estimated_saved_tokens: savedTokens != null && savedTokens > 0 ? savedTokens : 0,
        raw_char_count: rawCharCount != null && rawCharCount > 0 ? rawCharCount : 0,
        output_char_count: outputCharCount != null && outputCharCount >= 0 ? outputCharCount : null,
        estimated_saved_chars: savedChars != null && savedChars > 0 ? savedChars : 0,
        baseline_known: rawTokenEstimate != null && rawTokenEstimate > 0,
        char_baseline_known: rawCharCount != null && rawCharCount > 0
    };
}

function getReviewContextSummary(payload: Record<string, unknown> | null | undefined) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const ruleContext = payload.rule_context as Record<string, unknown> | null | undefined;
    if (!ruleContext || typeof ruleContext !== 'object') {
        return null;
    }
    const summary = ruleContext.summary as Record<string, unknown> | null | undefined;
    if (!summary || typeof summary !== 'object') {
        return null;
    }
    const savedTokens = coerceIntLike(summary.estimated_saved_tokens);
    const savedChars = coerceIntLike(summary.estimated_saved_chars);
    if ((savedTokens == null || savedTokens <= 0) && (savedChars == null || savedChars <= 0)) {
        return null;
    }
    const rawTokenEstimate = coerceIntLike(summary.original_token_count_estimate);
    const outputTokenEstimate = coerceIntLike(summary.output_token_count_estimate);
    const rawCharCount = coerceIntLike(summary.original_char_count);
    const outputCharCount = coerceIntLike(summary.output_char_count);
    return {
        raw_token_count_estimate: rawTokenEstimate != null && rawTokenEstimate > 0 ? rawTokenEstimate : 0,
        output_token_count_estimate: outputTokenEstimate != null && outputTokenEstimate >= 0 ? outputTokenEstimate : null,
        estimated_saved_tokens: savedTokens != null && savedTokens > 0 ? savedTokens : 0,
        raw_char_count: rawCharCount != null && rawCharCount > 0 ? rawCharCount : 0,
        output_char_count: outputCharCount != null && outputCharCount >= 0 ? outputCharCount : null,
        estimated_saved_chars: savedChars != null && savedChars > 0 ? savedChars : 0,
        baseline_known: rawTokenEstimate != null && rawTokenEstimate > 0,
        char_baseline_known: rawCharCount != null && rawCharCount > 0
    };
}

interface TokenContributionEntry {
    label: string;
    estimated_saved_chars: number;
    estimated_saved_tokens: number;
    raw_char_count: number;
    output_char_count: number | null;
    raw_token_count_estimate: number;
    output_token_count_estimate: number | null;
    source_kind: string;
    source_key: string;
    source_path?: string | null;
    source_event_type?: string | null;
    source_index?: number | null;
}

export interface TaskCycleBindingSnapshot {
    preflight_path: string | null;
    preflight_sha256: string | null;
    compile_gate_timestamp: string | null;
    scope_binding?: TaskCycleScopeBinding | null;
}

export interface TaskCycleScopeBinding {
    changed_files_sha256: string | null;
    scope_sha256: string | null;
    scope_content_sha256: string | null;
}

export function normalizeCycleBindingPath(pathValue: unknown, repoRoot: string | null): string | null {
    const resolvedPath = resolveArtifactPathForRead(pathValue, repoRoot);
    if (resolvedPath) {
        return toPosix(resolvedPath);
    }
    if (typeof pathValue !== 'string') {
        return null;
    }
    const trimmed = pathValue.trim();
    return trimmed ? toPosix(trimmed) : null;
}

export function getCycleBindingSnapshotFromPayload(
    payload: Record<string, unknown> | null | undefined,
    repoRoot: string | null
): TaskCycleBindingSnapshot | null {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const cycleBinding = payload.cycle_binding as Record<string, unknown> | null | undefined;
    if (!cycleBinding || typeof cycleBinding !== 'object') {
        return null;
    }
    const preflightSha = typeof cycleBinding.preflight_sha256 === 'string'
        ? cycleBinding.preflight_sha256
        : null;
    const compileGateTimestamp = typeof cycleBinding.compile_gate_timestamp === 'string'
        ? cycleBinding.compile_gate_timestamp
        : null;
    const preflightPath = normalizeCycleBindingPath(cycleBinding.preflight_path, repoRoot);
    if (!preflightSha && !compileGateTimestamp && !preflightPath) {
        return null;
    }
    return {
        preflight_path: preflightPath,
        preflight_sha256: preflightSha,
        compile_gate_timestamp: compileGateTimestamp,
        scope_binding: normalizeTaskCycleScopeBinding(cycleBinding)
    };
}

export function normalizeTaskCycleScopeBinding(record: Record<string, unknown> | null | undefined): TaskCycleScopeBinding | null {
    if (!record || typeof record !== 'object') {
        return null;
    }
    const nested = record.scope_binding && typeof record.scope_binding === 'object' && !Array.isArray(record.scope_binding)
        ? record.scope_binding as Record<string, unknown>
        : record;
    const changedFilesSha256 = normalizeSha256Like(
        nested.changed_files_sha256
            ?? nested.preflight_changed_files_sha256
            ?? nested.scope_changed_files_sha256
    );
    const scopeSha256 = normalizeSha256Like(nested.scope_sha256 ?? nested.preflight_scope_sha256);
    const scopeContentSha256 = normalizeSha256Like(nested.scope_content_sha256 ?? nested.preflight_scope_content_sha256);
    if (!changedFilesSha256 && !scopeSha256 && !scopeContentSha256) {
        return null;
    }
    return {
        changed_files_sha256: changedFilesSha256,
        scope_sha256: scopeSha256,
        scope_content_sha256: scopeContentSha256
    };
}

function normalizeSha256Like(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

export function taskCycleScopeBindingsMatch(
    currentCycle: TaskCycleBindingSnapshot | null,
    candidateCycle: TaskCycleBindingSnapshot | null
): boolean {
    if (!currentCycle?.compile_gate_timestamp || !candidateCycle?.compile_gate_timestamp) {
        return false;
    }
    const current = currentCycle?.scope_binding;
    const candidate = candidateCycle?.scope_binding;
    if (!current || !candidate) {
        return false;
    }
    return !!current.changed_files_sha256
        && current.changed_files_sha256 === candidate.changed_files_sha256
        && !!current.scope_sha256
        && current.scope_sha256 === candidate.scope_sha256
        && !!current.scope_content_sha256
        && current.scope_content_sha256 === candidate.scope_content_sha256;
}

export function buildTaskCycleBindingKey(snapshot: TaskCycleBindingSnapshot | null): string | null {
    if (!snapshot || !snapshot.compile_gate_timestamp) {
        return null;
    }
    const cycleIdentity = snapshot.preflight_sha256 || snapshot.preflight_path;
    if (!cycleIdentity) {
        return null;
    }
    return `${snapshot.compile_gate_timestamp}:${cycleIdentity}`;
}

export function readTaskCycleBindingSnapshot(
    taskId: string,
    repoRoot: string | null,
    reviewsRootOverride?: string | null
): TaskCycleBindingSnapshot | null {
    const effectiveReviewsRoot = reviewsRootOverride
        ? path.resolve(String(reviewsRootOverride))
        : repoRoot
            ? joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'))
            : null;
    if (!effectiveReviewsRoot) {
        return null;
    }
    const safeTaskId = assertValidTaskId(taskId);
    const compileGateArtifact = safeReadJson(path.join(effectiveReviewsRoot, `${safeTaskId}-compile-gate.json`));
    if (!compileGateArtifact) {
        return null;
    }
    const preflightSha = typeof compileGateArtifact.preflight_hash_sha256 === 'string'
        ? compileGateArtifact.preflight_hash_sha256
        : null;
    const compileGateTimestamp = typeof compileGateArtifact.timestamp_utc === 'string'
        ? compileGateArtifact.timestamp_utc
        : null;
    const preflightPath = normalizeCycleBindingPath(compileGateArtifact.preflight_path, repoRoot);
    if (!preflightSha && !compileGateTimestamp && !preflightPath) {
        return null;
    }
    return {
        preflight_path: preflightPath,
        preflight_sha256: preflightSha,
        compile_gate_timestamp: compileGateTimestamp,
        scope_binding: normalizeTaskCycleScopeBinding(compileGateArtifact)
    };
}

function getCompileGateSnapshotFromEvent(
    event: Record<string, unknown>,
    repoRoot: string | null
): TaskCycleBindingSnapshot | null {
    const timestamp = formatTimestamp(event.timestamp_utc);
    const details = event.details && typeof event.details === 'object'
        ? event.details as Record<string, unknown>
        : null;
    const preflightSha = details && typeof details.preflight_hash_sha256 === 'string'
        ? details.preflight_hash_sha256
        : null;
    const preflightPath = normalizeCycleBindingPath(details?.preflight_path, repoRoot);
    if (!timestamp && !preflightSha && !preflightPath) {
        return null;
    }
    return {
        preflight_path: preflightPath,
        preflight_sha256: preflightSha,
        compile_gate_timestamp: timestamp,
        scope_binding: normalizeTaskCycleScopeBinding(details)
    };
}

export function resolveTaskCycleBindingSnapshot(
    taskId: string,
    events: ReadonlyArray<Record<string, unknown>>,
    repoRoot: string | null,
    reviewsRootOverride?: string | null
): TaskCycleBindingSnapshot | null {
    const artifactSnapshot = readTaskCycleBindingSnapshot(taskId, repoRoot, reviewsRootOverride);
    let latestCompileSnapshot: TaskCycleBindingSnapshot | null = null;

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (eventType !== 'COMPILE_GATE_PASSED' && eventType !== 'COMPILE_GATE_FAILED') {
            continue;
        }
        latestCompileSnapshot = getCompileGateSnapshotFromEvent(event, repoRoot);
        break;
    }

    if (!latestCompileSnapshot?.compile_gate_timestamp) {
        return artifactSnapshot;
    }
    if (!artifactSnapshot) {
        return latestCompileSnapshot.preflight_path || latestCompileSnapshot.preflight_sha256
            ? latestCompileSnapshot
            : null;
    }
    const artifactTime = parseTimestamp(artifactSnapshot.compile_gate_timestamp).getTime();
    const latestEventTime = parseTimestamp(latestCompileSnapshot.compile_gate_timestamp).getTime();
    if (latestCompileSnapshot.preflight_path || latestCompileSnapshot.preflight_sha256) {
        return latestCompileSnapshot;
    }
    if (latestEventTime > artifactTime) {
        return latestCompileSnapshot;
    }

    return {
        preflight_path: artifactSnapshot.preflight_path,
        preflight_sha256: artifactSnapshot.preflight_sha256,
        compile_gate_timestamp: latestCompileSnapshot.compile_gate_timestamp,
        scope_binding: artifactSnapshot.scope_binding ?? latestCompileSnapshot.scope_binding ?? null
    };
}

export function shouldIncludeFullSuiteTelemetryForCurrentCycle(
    eventType: string,
    eventTimestamp: unknown,
    payload: Record<string, unknown> | null | undefined,
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string | null
): boolean {
    const normalizedEventType = String(eventType || '').trim().toUpperCase();
    if (!normalizedEventType.startsWith('FULL_SUITE_VALIDATION_')) {
        return true;
    }
    if (!currentCycle || !currentCycle.compile_gate_timestamp) {
        return true;
    }

    const candidateCycle = getCycleBindingSnapshotFromPayload(payload, repoRoot);
    const sameScopeEvidence = taskCycleScopeBindingsMatch(currentCycle, candidateCycle);

    if (
        currentCycle.preflight_path
        && candidateCycle?.preflight_path
        && candidateCycle.preflight_path !== currentCycle.preflight_path
    ) {
        return false;
    }

    const eventDate = parseTimestamp(eventTimestamp);
    const compileGateDate = parseTimestamp(currentCycle.compile_gate_timestamp);
    if (
        eventDate.getTime() > 0
        && compileGateDate.getTime() > 0
        && eventDate.getTime() < compileGateDate.getTime()
        && !sameScopeEvidence
    ) {
        return false;
    }

    if (!candidateCycle) {
        return true;
    }
    if (
        currentCycle.preflight_sha256
        && candidateCycle.preflight_sha256
        && candidateCycle.preflight_sha256 !== currentCycle.preflight_sha256
        && !sameScopeEvidence
    ) {
        return false;
    }
    if (
        candidateCycle.compile_gate_timestamp
        && candidateCycle.compile_gate_timestamp !== currentCycle.compile_gate_timestamp
        && !sameScopeEvidence
    ) {
        return false;
    }
    return true;
}

export function shouldIncludeTelemetryForCurrentCycle(
    eventType: string,
    eventTimestamp: unknown,
    payload: Record<string, unknown> | null | undefined,
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string | null
): boolean {
    if (!currentCycle?.compile_gate_timestamp) {
        return true;
    }

    const normalizedEventType = String(eventType || '').trim().toUpperCase();
    if (normalizedEventType.startsWith('FULL_SUITE_VALIDATION_')) {
        return shouldIncludeFullSuiteTelemetryForCurrentCycle(
            eventType,
            eventTimestamp,
            payload,
            currentCycle,
            repoRoot
        );
    }

    const eventDate = parseTimestamp(eventTimestamp);
    const compileGateDate = parseTimestamp(currentCycle.compile_gate_timestamp);
    if (
        eventDate.getTime() > 0
        && compileGateDate.getTime() > 0
        && eventDate.getTime() < compileGateDate.getTime()
    ) {
        return false;
    }

    return true;
}

export function getCurrentCycleReviewContextPaths(
    events: Record<string, unknown>[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): Map<string, string> {
    const reviewContextPaths = new Map<string, string>();

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventType = String(event.event_type || '').trim().toUpperCase();
        const details = event.details && typeof event.details === 'object'
            ? event.details as Record<string, unknown>
            : null;
        if (
            !details
            || !shouldIncludeTelemetryForCurrentCycle(
                eventType,
                event.timestamp_utc,
                details,
                currentCycle,
                repoRoot
            )
        ) {
            continue;
        }

        const reviewType = String(
            details.review_type
            || details.reviewType
            || ''
        ).trim().toLowerCase();
        if (!reviewType || reviewContextPaths.has(reviewType)) {
            continue;
        }

        let candidatePath = '';
        if (eventType === 'REVIEW_RECORDED') {
            candidatePath = String(details.review_context_path || details.reviewContextPath || '').trim();
        } else if (eventType === 'REVIEW_PHASE_STARTED') {
            candidatePath = String(details.output_path || details.review_context_path || details.reviewContextPath || '').trim();
        } else {
            continue;
        }
        if (!candidatePath) {
            continue;
        }

        const resolvedPath = resolveArtifactPathForRead(candidatePath, repoRoot);
        if (!resolvedPath) {
            continue;
        }
        reviewContextPaths.set(reviewType, resolvedPath);
    }

    return reviewContextPaths;
}

function addTokenEconomyContribution(
    breakdown: TokenContributionEntry[],
    sourceIndexByKey: Map<string, number>,
    contribution: Partial<TokenContributionEntry> & {
        estimated_saved_tokens?: number;
        estimated_saved_chars?: number;
        source_key?: string;
        label?: string;
    }
): void {
    if (
        !contribution
        || ((contribution.estimated_saved_tokens || 0) <= 0 && (contribution.estimated_saved_chars || 0) <= 0)
    ) {
        return;
    }
    const sourceKey = String(contribution.source_key || '').trim();
    if (!sourceKey) {
        return;
    }
    const normalizedContribution = {
        label: contribution.label || '',
        estimated_saved_chars: contribution.estimated_saved_chars || 0,
        estimated_saved_tokens: contribution.estimated_saved_tokens || 0,
        raw_char_count: contribution.raw_char_count || 0,
        output_char_count: contribution.output_char_count ?? null,
        raw_token_count_estimate: contribution.raw_token_count_estimate || 0,
        output_token_count_estimate: contribution.output_token_count_estimate ?? null,
        source_kind: contribution.source_kind || '',
        source_key: sourceKey,
        source_path: contribution.source_path || null,
        source_event_type: contribution.source_event_type || null,
        source_index: contribution.source_index || null
    };
    const existingIndex = sourceIndexByKey.get(sourceKey);
    if (existingIndex != null) {
        breakdown[existingIndex] = normalizedContribution;
        return;
    }
    sourceIndexByKey.set(sourceKey, breakdown.length);
    breakdown.push(normalizedContribution);
}

function collectReviewContextContributions(
    container: Record<string, unknown>,
    repoRoot: string | null,
    breakdown: TokenContributionEntry[],
    sourceIndexByKey: Map<string, number>
): void {
    if (!container || typeof container !== 'object') {
        return;
    }
    const artifactEvidence = container.artifact_evidence as Record<string, unknown> | null | undefined;
    const checked = artifactEvidence && Array.isArray((artifactEvidence as Record<string, unknown>).checked)
        ? (artifactEvidence as Record<string, unknown>).checked as Record<string, unknown>[]
        : [];
    for (const entry of checked) {
        if (!entry || typeof entry !== 'object' || !entry.review_context_path) {
            continue;
        }
        const reviewContextArtifact = readJsonArtifactForSummary(entry.review_context_path, repoRoot);
        if (!reviewContextArtifact) {
            continue;
        }
        const summary = getReviewContextSummary(reviewContextArtifact.payload);
        if (!summary) {
            continue;
        }
        addTokenEconomyContribution(breakdown, sourceIndexByKey, {
            label: getReviewContextOutputLabel(String(reviewContextArtifact.payload.review_type || entry.review || '')),
            estimated_saved_chars: summary.estimated_saved_chars,
            estimated_saved_tokens: summary.estimated_saved_tokens,
            raw_char_count: summary.raw_char_count,
            output_char_count: summary.output_char_count,
            raw_token_count_estimate: summary.raw_token_count_estimate,
            output_token_count_estimate: summary.output_token_count_estimate,
            source_kind: 'review_context',
            source_key: `review-context:${reviewContextArtifact.path}`,
            source_path: reviewContextArtifact.path
        });
    }
}

function getCommandOutputSourceKey(
    eventType: string,
    details: Record<string, unknown>,
    index: number,
    repoRoot: string | null
): string {
    const normalizedEventType = String(eventType || '').trim().toUpperCase();
    if (normalizedEventType.startsWith('FULL_SUITE_VALIDATION_')) {
        const cycleKey = buildTaskCycleBindingKey(getCycleBindingSnapshotFromPayload(details, repoRoot));
        if (cycleKey) {
            return `command-output:full-suite-cycle:${cycleKey}`;
        }
        if (typeof details.artifact_path === 'string' && details.artifact_path.trim()) {
            const normalizedPath = normalizeCycleBindingPath(details.artifact_path, repoRoot);
            if (normalizedPath) {
                return `command-output:${normalizedPath}`;
            }
        }
    }
    return `command-output:event:${index}:${eventType}`;
}

export function buildTokenEconomySummary(
    taskId: string,
    events: Record<string, unknown>[],
    repoRoot: string | null,
    reviewsRootOverride?: string | null
) {
    const breakdown: TokenContributionEntry[] = [];
    const sourceIndexByKey = new Map<string, number>();
    const currentCycle = resolveTaskCycleBindingSnapshot(taskId, events, repoRoot, reviewsRootOverride);

    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const rawDetails = event && typeof event === 'object' ? event.details : null;
        if (!rawDetails || typeof rawDetails !== 'object') {
            continue;
        }
        const details = rawDetails as Record<string, unknown>;

        const eventType = String(event.event_type || 'UNKNOWN');
        let reviewEvidencePayload: Record<string, unknown> | null = null;

        if (typeof details.review_evidence_path === 'string' && details.review_evidence_path.trim()) {
            const reviewEvidence = readJsonArtifactForSummary(details.review_evidence_path, repoRoot);
            if (reviewEvidence) {
                reviewEvidencePayload = reviewEvidence.payload;
                const reviewTelemetry = getOutputTelemetryFromPayload(reviewEvidence.payload);
                const includeCurrentCycleTelemetry = shouldIncludeTelemetryForCurrentCycle(
                    eventType,
                    event.timestamp_utc,
                    reviewEvidence.payload,
                    currentCycle,
                    repoRoot
                );
                if (reviewTelemetry && includeCurrentCycleTelemetry) {
                    addTokenEconomyContribution(breakdown, sourceIndexByKey, {
                        label: getGateOutputCompactionLabel(eventType),
                        estimated_saved_chars: reviewTelemetry.estimated_saved_chars,
                        estimated_saved_tokens: reviewTelemetry.estimated_saved_tokens,
                        raw_char_count: reviewTelemetry.raw_char_count,
                        output_char_count: reviewTelemetry.output_char_count,
                        raw_token_count_estimate: reviewTelemetry.raw_token_count_estimate,
                        output_token_count_estimate: reviewTelemetry.output_token_count_estimate,
                        source_kind: 'command_output',
                        source_key: `command-output:${reviewEvidence.path}`,
                        source_path: reviewEvidence.path,
                        source_event_type: eventType,
                        source_index: index + 1
                    });
                }
                if (includeCurrentCycleTelemetry) {
                    collectReviewContextContributions(reviewEvidence.payload, repoRoot, breakdown, sourceIndexByKey);
                }
            }
        }

        if (!reviewEvidencePayload) {
            const directTelemetry = getOutputTelemetryFromPayload(details);
            const includeCurrentCycleTelemetry = shouldIncludeTelemetryForCurrentCycle(
                eventType,
                event.timestamp_utc,
                details,
                currentCycle,
                repoRoot
            );
            if (directTelemetry && includeCurrentCycleTelemetry) {
                addTokenEconomyContribution(breakdown, sourceIndexByKey, {
                    label: getGateOutputCompactionLabel(eventType),
                    estimated_saved_chars: directTelemetry.estimated_saved_chars,
                    estimated_saved_tokens: directTelemetry.estimated_saved_tokens,
                    raw_char_count: directTelemetry.raw_char_count,
                    output_char_count: directTelemetry.output_char_count,
                    raw_token_count_estimate: directTelemetry.raw_token_count_estimate,
                    output_token_count_estimate: directTelemetry.output_token_count_estimate,
                    source_kind: 'command_output',
                    source_key: getCommandOutputSourceKey(eventType, details, index + 1, repoRoot),
                    source_event_type: eventType,
                    source_index: index + 1
                });
            }
            if (includeCurrentCycleTelemetry) {
                collectReviewContextContributions(details, repoRoot, breakdown, sourceIndexByKey);
            }
        }
    }

    const resolvedReviewsRoot = reviewsRootOverride
        ? path.resolve(String(reviewsRootOverride))
        : repoRoot
            ? joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'))
            : null;
    const currentCycleReviewContextPaths = currentCycle?.compile_gate_timestamp && repoRoot
        ? getCurrentCycleReviewContextPaths(events, currentCycle, repoRoot)
        : new Map<string, string>();
    if (!currentCycle?.compile_gate_timestamp && resolvedReviewsRoot) {
        for (const reviewType of CANONICAL_REVIEW_CONTEXT_TYPES) {
            currentCycleReviewContextPaths.set(
                reviewType,
                path.join(resolvedReviewsRoot, `${taskId}-${reviewType}-review-context.json`)
            );
        }
    }
    for (const [reviewType, contextPath] of currentCycleReviewContextPaths.entries()) {
        const resolvedPath = resolveArtifactPathForRead(contextPath, repoRoot);
        if (!resolvedPath) {
            continue;
        }
        const contextKey = `review-context:${toPosix(resolvedPath)}`;
        if (sourceIndexByKey.has(contextKey)) {
            continue;
        }
        const payload = safeReadJson(resolvedPath);
        if (!payload) {
            continue;
        }
        const summary = getReviewContextSummary(payload);
        if (!summary) {
            continue;
        }
        addTokenEconomyContribution(breakdown, sourceIndexByKey, {
            label: getReviewContextOutputLabel(String(payload.review_type || reviewType || '')),
            estimated_saved_chars: summary.estimated_saved_chars,
            estimated_saved_tokens: summary.estimated_saved_tokens,
            raw_char_count: summary.raw_char_count,
            output_char_count: summary.output_char_count,
            raw_token_count_estimate: summary.raw_token_count_estimate,
            output_token_count_estimate: summary.output_token_count_estimate,
            source_kind: 'review_context',
            source_key: contextKey,
            source_path: toPosix(resolvedPath)
        });
    }

    const aggregateSummary = summarizeOutputCompactionBreakdown(breakdown);

    return {
        total_estimated_saved_chars: aggregateSummary.total_estimated_saved_chars,
        total_raw_char_count: aggregateSummary.total_raw_char_count,
        total_output_char_count: aggregateSummary.total_output_char_count,
        total_estimated_saved_tokens: aggregateSummary.total_estimated_saved_tokens,
        total_raw_token_count_estimate: aggregateSummary.total_raw_token_count_estimate,
        total_output_token_count_estimate: aggregateSummary.total_output_token_count_estimate,
        baseline_known: aggregateSummary.baseline_known,
        char_baseline_known: aggregateSummary.char_baseline_known,
        measurable_part_count: aggregateSummary.measurable_part_count,
        breakdown,
        visible_summary_line: aggregateSummary.visible_summary_line
    };
}

export interface BuildTaskEventsSummaryOptions {
    taskId: string;
    eventsRoot: string;
    repoRoot?: string | null;
    reviewsRoot?: string | null;
}

type CompactGateStatus = 'PASS' | 'FAIL' | 'INFO';

interface CompactGateOutcome {
    gate: string;
    status: CompactGateStatus;
    event_type: string;
    outcome: string;
    timestamp_utc: string | null;
    message: string;
    evidence_paths: string[];
}

export interface CompactLatestCycleTaskEventsSummary {
    schema_version: 2;
    mode: 'compact_latest_cycle';
    task_id: string;
    source_path: string;
    event_contract: {
        schema_version: 2;
        legacy_schema_versions: number[];
        current_schema_event_count: number;
        legacy_schema_event_count: number;
        unknown_schema_version_count: number;
    };
    integrity: {
        status: string;
        integrity_event_count: number;
        legacy_event_count: number;
        violations_count: number;
    };
    events_count: number;
    latest_cycle: {
        cycle_event_count: number;
        start_index: number | null;
        end_index: number | null;
        started_at_utc: string | null;
        last_event_utc: string | null;
        status: 'PASS' | 'BLOCKED' | 'IN_PROGRESS';
        health_state: TaskEventHealthState;
        terminal_outcome: TaskEventTerminalOutcome;
        blocking_reason: {
            gate: string;
            event_type: string;
            outcome: string;
            timestamp_utc: string | null;
            message: string;
        } | null;
        gate_outcomes: CompactGateOutcome[];
        evidence_references: string[];
    };
    token_economy: {
        visible_summary_line: string | null;
        total_estimated_saved_chars?: number;
        total_raw_char_count?: number;
        total_estimated_saved_tokens?: number;
        baseline_known?: boolean;
        measurable_part_count?: number;
    } | null;
}

function normalizeCompactStatus(outcome: string, eventType: string): CompactGateStatus {
    const normalizedOutcome = outcome.trim().toUpperCase();
    const normalizedEventType = eventType.trim().toUpperCase();
    if (normalizedOutcome === 'FAIL' || normalizedOutcome === 'FAILED' || normalizedEventType.endsWith('_FAILED')) {
        return 'FAIL';
    }
    if (normalizedOutcome === 'BLOCKED' || normalizedEventType.endsWith('_BLOCKED')) {
        return 'FAIL';
    }
    if (
        normalizedOutcome === 'PASS'
        || normalizedOutcome === 'PASSED'
        || normalizedOutcome === 'WARNED'
        || normalizedOutcome === 'SKIPPED'
        || normalizedEventType.endsWith('_PASSED')
        || normalizedEventType.endsWith('_RECORDED')
        || normalizedEventType.endsWith('_COMPLETE')
        || normalizedEventType === 'TASK_MODE_ENTERED'
        || normalizedEventType === 'RULE_PACK_LOADED'
        || normalizedEventType === 'PREFLIGHT_CLASSIFIED'
    ) {
        return 'PASS';
    }
    return 'INFO';
}

function resolveGateName(eventType: string, details: unknown): string | null {
    const normalizedEventType = eventType.trim().toUpperCase();
    const detailRecord = details && typeof details === 'object' ? details as Record<string, unknown> : {};
    switch (normalizedEventType) {
        case 'TASK_MODE_ENTERED':
            return 'enter-task-mode';
        case 'RULE_PACK_LOADED': {
            const stage = String(detailRecord.stage || '').trim();
            return stage ? `load-rule-pack:${stage}` : 'load-rule-pack';
        }
        case 'HANDSHAKE_DIAGNOSTICS_RECORDED':
            return 'handshake-diagnostics';
        case 'SHELL_SMOKE_PREFLIGHT_RECORDED':
            return 'shell-smoke-preflight';
        case 'PREFLIGHT_CLASSIFIED':
        case 'PREFLIGHT_FAILED':
            return 'classify-change';
        case 'IMPLEMENTATION_STARTED':
            return 'implementation';
        case 'COMPILE_GATE_PASSED':
        case 'COMPILE_GATE_FAILED':
            return 'compile-gate';
        case 'REVIEW_PHASE_STARTED': {
            const reviewType = String(detailRecord.review_type || '').trim();
            return reviewType ? `build-review-context:${reviewType}` : 'build-review-context';
        }
        case 'REVIEW_GATE_PASSED':
        case 'REVIEW_GATE_PASSED_WITH_OVERRIDE':
        case 'REVIEW_GATE_FAILED':
            return 'required-reviews-check';
        case 'DOC_IMPACT_ASSESSED':
        case 'DOC_IMPACT_GATE_PASSED':
        case 'DOC_IMPACT_ASSESSMENT_FAILED':
        case 'DOC_IMPACT_GATE_FAILED':
            return 'doc-impact-gate';
        case 'FULL_SUITE_VALIDATION_PASSED':
        case 'FULL_SUITE_VALIDATION_WARNED':
        case 'FULL_SUITE_VALIDATION_SKIPPED':
        case 'FULL_SUITE_VALIDATION_FAILED':
        case 'FULL_SUITE_VALIDATION_COMPLETE':
            return 'full-suite-validation';
        case 'PROJECT_MEMORY_IMPACT_ASSESSED':
        case 'PROJECT_MEMORY_IMPACT_BLOCKED':
        case 'PROJECT_MEMORY_IMPACT_PASSED':
        case 'PROJECT_MEMORY_IMPACT_UPDATED':
        case 'PROJECT_MEMORY_IMPACT_SKIPPED':
        case 'PROJECT_MEMORY_IMPACT_FAILED':
        case 'PROJECT_MEMORY_IMPACT_RECORDED':
            return 'project-memory-impact';
        case 'COMPLETION_GATE_PASSED':
        case 'COMPLETION_GATE_FAILED':
            return 'completion-gate';
        case 'NO_OP_RECORDED':
            return 'record-no-op';
        default:
            return null;
    }
}

function collectEvidencePaths(value: unknown, result: string[] = [], maxCount = 20): string[] {
    if (result.length >= maxCount || value == null) return result;
    if (typeof value === 'string') return result;
    if (Array.isArray(value)) {
        for (const item of value) {
            collectEvidencePaths(item, result, maxCount);
            if (result.length >= maxCount) break;
        }
        return result;
    }
    if (typeof value !== 'object') return result;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (result.length >= maxCount) break;
        const normalizedKey = key.toLowerCase();
        const isPathKey = normalizedKey === 'path'
            || normalizedKey.endsWith('_path')
            || normalizedKey.endsWith('_paths')
            || normalizedKey.endsWith('path')
            || normalizedKey.endsWith('paths');
        if (isPathKey) {
            const candidates = Array.isArray(nested) ? nested : [nested];
            for (const candidate of candidates) {
                if (typeof candidate !== 'string') continue;
                const trimmed = candidate.trim();
                if (!trimmed || result.includes(toPosix(trimmed))) continue;
                result.push(toPosix(trimmed));
                if (result.length >= maxCount) break;
            }
        } else {
            collectEvidencePaths(nested, result, maxCount);
        }
    }
    return result;
}

export function buildTaskEventsSummary(options: BuildTaskEventsSummaryOptions) {
    const taskId = options.taskId;
    const eventsRoot = options.eventsRoot;
    const repoRoot = options.repoRoot ? path.resolve(String(options.repoRoot)) : null;
    const reviewsRoot = options.reviewsRoot ? path.resolve(String(options.reviewsRoot)) : null;

    const safeTaskId = assertValidTaskId(taskId);
    const taskEventFile = path.join(eventsRoot, `${safeTaskId}.jsonl`);

    if (!fs.existsSync(taskEventFile) || !fs.statSync(taskEventFile).isFile()) {
        throw new Error(`Task events file not found: ${taskEventFile}`);
    }

    const rawLines: string[] = [];
    forEachJsonlLine(taskEventFile, (line: string) => {
        rawLines.push(line);
    });
    const events: Record<string, unknown>[] = [];
    let parseErrors = 0;
    const integrityReport = inspectTaskEventFile(taskEventFile, safeTaskId);

    for (const line of rawLines) {
        try {
            const event = JSON.parse(line);
            if (event != null) events.push(event);
        } catch {
            parseErrors++;
        }
    }

    events.sort(function (a, b) {
        const ta = parseTimestamp(typeof a === 'object' ? a.timestamp_utc : null);
        const tb = parseTimestamp(typeof b === 'object' ? b.timestamp_utc : null);
        return ta.getTime() - tb.getTime();
    });

interface TimelineEntry {
        index: number;
        timestamp_utc: string | null;
        schema_version: number | null;
        event_source: string | null;
        event_type: string;
        outcome: string;
        actor: string | null;
        message: string;
        lifecycle_phase: TaskEventLifecyclePhase;
        health_state: TaskEventHealthState;
        terminal_outcome: TaskEventTerminalOutcome;
        normalized_from_legacy: boolean;
        unknown_schema_version: boolean;
        details: unknown;
        command_policy_audit: ReturnType<typeof getCommandAuditFromDetails>;
    }

    const summary: {
        event_contract: {
            schema_version: 2;
            legacy_schema_versions: number[];
            current_schema_event_count: number;
            legacy_schema_event_count: number;
            unknown_schema_version_count: number;
        };
        task_id: string;
        source_path: string;
        events_count: number;
        parse_errors: number;
        integrity: ReturnType<typeof inspectTaskEventFile>;
        command_policy_warnings: string[];
        command_policy_warning_count: number;
        first_event_utc: string | null;
        last_event_utc: string | null;
        token_economy: ReturnType<typeof buildTokenEconomySummary> | null;
        timeline: TimelineEntry[];
    } = {
        event_contract: {
            schema_version: TASK_EVENT_PUBLIC_SCHEMA_VERSION,
            legacy_schema_versions: [TASK_EVENT_LEGACY_SCHEMA_VERSION],
            current_schema_event_count: 0,
            legacy_schema_event_count: 0,
            unknown_schema_version_count: 0
        },
        task_id: safeTaskId,
        source_path: toPosix(taskEventFile),
        events_count: events.length,
        parse_errors: parseErrors,
        integrity: integrityReport,
        command_policy_warnings: [],
        command_policy_warning_count: 0,
        first_event_utc: events.length > 0 ? formatTimestamp(events[0].timestamp_utc) : null,
        last_event_utc: events.length > 0 ? formatTimestamp(events[events.length - 1].timestamp_utc) : null,
        token_economy: null,
        timeline: []
    };

    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        const normalizedEvent = normalizeTaskEventPublicRecord(event);
        const index = i + 1;
        const details = event.details as Record<string, unknown> | null | undefined;
        const commandPolicyAudit = getCommandAuditFromDetails(details) as Record<string, unknown> | null;
        if (commandPolicyAudit && typeof commandPolicyAudit === 'object' && parseInt(String(commandPolicyAudit.warning_count || 0), 10) > 0) {
            summary.command_policy_warnings.push(...((commandPolicyAudit.warnings as string[]) || []));
        }
        if (normalizedEvent) {
            if (normalizedEvent.source_schema_version === TASK_EVENT_PUBLIC_SCHEMA_VERSION) {
                summary.event_contract.current_schema_event_count++;
            } else if (normalizedEvent.normalized_from_legacy) {
                summary.event_contract.legacy_schema_event_count++;
            }
            if (normalizedEvent.unknown_source_schema_version) {
                summary.event_contract.unknown_schema_version_count++;
            }
        } else {
            summary.event_contract.legacy_schema_event_count++;
        }
        summary.timeline.push({
            index,
            timestamp_utc: formatTimestamp(normalizedEvent?.timestamp_utc || event.timestamp_utc),
            schema_version: normalizedEvent?.source_schema_version ?? null,
            event_source: normalizedEvent?.event_source || null,
            event_type: normalizedEvent?.event_type || String(event.event_type || 'UNKNOWN'),
            outcome: normalizedEvent?.outcome || String(event.outcome || 'UNKNOWN'),
            actor: normalizedEvent?.actor || (event.actor != null ? String(event.actor) : null),
            message: normalizedEvent?.message || String(event.message || ''),
            lifecycle_phase: normalizedEvent?.public_metadata.lifecycle_phase || 'unknown',
            health_state: normalizedEvent?.public_metadata.health_state || 'neutral',
            terminal_outcome: normalizedEvent?.public_metadata.terminal_outcome || 'none',
            normalized_from_legacy: normalizedEvent?.normalized_from_legacy ?? true,
            unknown_schema_version: normalizedEvent?.unknown_source_schema_version ?? false,
            details,
            command_policy_audit: commandPolicyAudit
        });
    }
    summary.command_policy_warning_count = summary.command_policy_warnings.length;
    summary.token_economy = buildTokenEconomySummary(safeTaskId, events, repoRoot, reviewsRoot);

    return summary;
}

export interface TaskEventsSummaryResult {
    event_contract: {
        schema_version: 2;
        legacy_schema_versions: number[];
        current_schema_event_count: number;
        legacy_schema_event_count: number;
        unknown_schema_version_count: number;
    };
    task_id: string;
    source_path: string;
    events_count: number;
    parse_errors: number;
    integrity: {
        status: string;
        integrity_event_count: number;
        legacy_event_count: number;
        violations: string[];
    };
    command_policy_warnings: string[];
    command_policy_warning_count: number;
    first_event_utc: string | null;
    last_event_utc: string | null;
    token_economy: {
        visible_summary_line: string | null;
    } | null;
    timeline: {
        index: number;
        timestamp_utc: string | null;
        schema_version: number | null;
        event_source: string | null;
        event_type: string;
        outcome: string;
        actor: string | null;
        message: string;
        lifecycle_phase: TaskEventLifecyclePhase;
        health_state: TaskEventHealthState;
        terminal_outcome: TaskEventTerminalOutcome;
        normalized_from_legacy: boolean;
        unknown_schema_version: boolean;
        details: unknown;
    }[];
}

export function buildCompactLatestCycleTaskEventsSummary(summary: TaskEventsSummaryResult): CompactLatestCycleTaskEventsSummary {
    let startOffset = -1;
    for (let index = summary.timeline.length - 1; index >= 0; index--) {
        if (summary.timeline[index].event_type === 'TASK_MODE_ENTERED') {
            startOffset = index;
            break;
        }
    }
    if (startOffset < 0 && summary.timeline.length > 0) startOffset = 0;
    const latestCycleTimeline = startOffset >= 0 ? summary.timeline.slice(startOffset) : [];
    const gateOutcomesByName = new Map<string, CompactGateOutcome>();
    const evidenceReferences: string[] = [];

    for (const item of latestCycleTimeline) {
        const gate = resolveGateName(item.event_type, item.details);
        const evidencePaths = collectEvidencePaths(item.details);
        for (const evidencePath of evidencePaths) {
            if (!evidenceReferences.includes(evidencePath) && evidenceReferences.length < 20) {
                evidenceReferences.push(evidencePath);
            }
        }
        if (!gate) continue;
        if (gateOutcomesByName.has(gate)) {
            gateOutcomesByName.delete(gate);
        }
        gateOutcomesByName.set(gate, {
            gate,
            status: normalizeCompactStatus(item.outcome, item.event_type),
            event_type: item.event_type,
            outcome: item.outcome,
            timestamp_utc: item.timestamp_utc,
            message: item.message,
            evidence_paths: evidencePaths
        });
    }

    const gateOutcomes = Array.from(gateOutcomesByName.values());
    let blockingOutcome: CompactGateOutcome | null = null;
    for (let index = gateOutcomes.length - 1; index >= 0; index--) {
        if (gateOutcomes[index].status === 'FAIL') {
            blockingOutcome = gateOutcomes[index];
            break;
        }
    }
    const completionPassed = gateOutcomes.some((item) => item.gate === 'completion-gate' && item.status === 'PASS');
    const status = blockingOutcome ? 'BLOCKED' : completionPassed ? 'PASS' : 'IN_PROGRESS';
    const firstCycleEvent = latestCycleTimeline[0] || null;
    const lastCycleEvent = latestCycleTimeline[latestCycleTimeline.length - 1] || null;
    let blockingTimelineEvent: TaskEventsSummaryResult['timeline'][number] | null = null;
    if (blockingOutcome) {
        for (let index = latestCycleTimeline.length - 1; index >= 0; index--) {
            const item = latestCycleTimeline[index];
            if (resolveGateName(item.event_type, item.details) !== blockingOutcome.gate) continue;
            if (normalizeCompactStatus(item.outcome, item.event_type) !== 'FAIL') continue;
            blockingTimelineEvent = item;
            break;
        }
    }
    let terminalTimelineEvent: TaskEventsSummaryResult['timeline'][number] | null = null;
    for (let index = latestCycleTimeline.length - 1; index >= 0; index--) {
        const item = latestCycleTimeline[index];
        if (item.terminal_outcome !== 'none') {
            terminalTimelineEvent = item;
            break;
        }
    }
    const healthState = status === 'BLOCKED'
        ? (blockingTimelineEvent?.health_state || 'blocked')
        : completionPassed
            ? 'healthy'
            : (lastCycleEvent?.health_state || 'neutral');
    const terminalOutcome = terminalTimelineEvent?.terminal_outcome || (completionPassed ? 'done' : 'none');
    const tokenEconomy = summary.token_economy == null ? null : {
        visible_summary_line: summary.token_economy.visible_summary_line || null,
        total_estimated_saved_chars: 'total_estimated_saved_chars' in summary.token_economy
            ? Number((summary.token_economy as Record<string, unknown>).total_estimated_saved_chars || 0)
            : undefined,
        total_raw_char_count: 'total_raw_char_count' in summary.token_economy
            ? Number((summary.token_economy as Record<string, unknown>).total_raw_char_count || 0)
            : undefined,
        total_estimated_saved_tokens: 'total_estimated_saved_tokens' in summary.token_economy
            ? Number((summary.token_economy as Record<string, unknown>).total_estimated_saved_tokens || 0)
            : undefined,
        baseline_known: 'baseline_known' in summary.token_economy
            ? Boolean((summary.token_economy as Record<string, unknown>).baseline_known)
            : undefined,
        measurable_part_count: 'measurable_part_count' in summary.token_economy
            ? Number((summary.token_economy as Record<string, unknown>).measurable_part_count || 0)
            : undefined
    };

    return {
        schema_version: 2,
        mode: 'compact_latest_cycle',
        task_id: summary.task_id,
        source_path: summary.source_path,
        event_contract: {
            schema_version: TASK_EVENT_PUBLIC_SCHEMA_VERSION,
            legacy_schema_versions: [TASK_EVENT_LEGACY_SCHEMA_VERSION],
            current_schema_event_count: summary.event_contract.current_schema_event_count,
            legacy_schema_event_count: summary.event_contract.legacy_schema_event_count,
            unknown_schema_version_count: summary.event_contract.unknown_schema_version_count
        },
        integrity: {
            status: summary.integrity.status,
            integrity_event_count: summary.integrity.integrity_event_count,
            legacy_event_count: summary.integrity.legacy_event_count,
            violations_count: summary.integrity.violations.length
        },
        events_count: summary.events_count,
        latest_cycle: {
            cycle_event_count: latestCycleTimeline.length,
            start_index: firstCycleEvent ? firstCycleEvent.index : null,
            end_index: lastCycleEvent ? lastCycleEvent.index : null,
            started_at_utc: firstCycleEvent ? firstCycleEvent.timestamp_utc : null,
            last_event_utc: lastCycleEvent ? lastCycleEvent.timestamp_utc : null,
            status,
            health_state: healthState,
            terminal_outcome: terminalOutcome,
            blocking_reason: blockingOutcome ? {
                gate: blockingOutcome.gate,
                event_type: blockingOutcome.event_type,
                outcome: blockingOutcome.outcome,
                timestamp_utc: blockingOutcome.timestamp_utc,
                message: blockingOutcome.message
            } : null,
            gate_outcomes: gateOutcomes,
            evidence_references: evidenceReferences
        },
        token_economy: tokenEconomy
    };
}

