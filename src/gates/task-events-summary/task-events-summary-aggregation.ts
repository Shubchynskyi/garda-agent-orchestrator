import * as fs from 'node:fs';
import * as path from 'node:path';
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
} from '../../gate-runtime/task-events';
import { toPosix } from '../shared/helpers';
import { formatTimestamp, parseTimestamp } from './task-events-summary-parsing';
import { getCommandAuditFromDetails } from './task-events-summary-noise';
import { buildTokenEconomySummary } from './task-events-summary-token-economy';

export {
    getOutputTelemetryFromPayload,
    buildTokenEconomySummary
} from './task-events-summary-token-economy';
export {
    buildTaskCycleBindingKey,
    getCurrentCycleReviewContextPaths,
    getCycleBindingSnapshotFromPayload,
    normalizeCycleBindingPath,
    normalizeTaskCycleScopeBinding,
    readTaskCycleBindingSnapshot,
    resolveTaskCycleBindingSnapshot,
    shouldIncludeFullSuiteTelemetryForCurrentCycle,
    shouldIncludeTelemetryForCurrentCycle,
    taskCycleScopeBindingsMatch
} from './task-events-summary-cycle-binding';
export type {
    TaskCycleBindingSnapshot,
    TaskCycleScopeBinding
} from './task-events-summary-cycle-binding';
export {
    buildCompactLatestCycleTaskEventsSummary
} from './task-events-summary-compact-latest-cycle';
export type {
    CompactLatestCycleTaskEventsSummary
} from './task-events-summary-compact-latest-cycle';

export interface BuildTaskEventsSummaryOptions {
    taskId: string;
    eventsRoot: string;
    repoRoot?: string | null;
    reviewsRoot?: string | null;
}

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
