import {
    TASK_EVENT_LEGACY_SCHEMA_VERSION,
    TASK_EVENT_PUBLIC_SCHEMA_VERSION,
    type TaskEventHealthState,
    type TaskEventTerminalOutcome
} from '../gate-runtime/task-events';
import { toPosix } from './helpers';
import type { TaskEventsSummaryResult } from './task-events-summary-aggregation';

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
