import * as path from 'node:path';
import {
    CANONICAL_REVIEW_CONTEXT_TYPES,
    getGateOutputCompactionLabel,
    getReviewContextOutputLabel,
    summarizeOutputCompactionBreakdown
} from '../../gate-runtime/output-compaction-reporting';
import { coerceIntLike } from '../../gate-runtime/token-telemetry';
import { joinOrchestratorPath, toPosix } from '../shared/helpers';
import { readJsonArtifactForSummary, resolveArtifactPathForRead, safeReadJson } from './task-events-summary-artifacts';
import {
    buildTaskCycleBindingKey,
    getCurrentCycleReviewContextPaths,
    getCycleBindingSnapshotFromPayload,
    normalizeCycleBindingPath,
    resolveTaskCycleBindingSnapshot,
    shouldIncludeTelemetryForCurrentCycle
} from './task-events-summary-cycle-binding';

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
