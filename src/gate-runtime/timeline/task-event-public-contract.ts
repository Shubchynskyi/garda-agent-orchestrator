export const TASK_EVENT_PUBLIC_SCHEMA_VERSION = 2 as const;
export const TASK_EVENT_LEGACY_SCHEMA_VERSION = 1 as const;
export const TASK_EVENT_PUBLIC_EVENT_SOURCE = 'task-events' as const;

export type TaskEventLifecyclePhase =
    | 'startup'
    | 'preflight'
    | 'implementation'
    | 'validation'
    | 'review'
    | 'closeout'
    | 'terminal'
    | 'unknown';

export type TaskEventStatusSignal = 'pass' | 'fail' | 'blocked' | 'attention' | 'info';
export type TaskEventHealthState = 'healthy' | 'failed' | 'blocked' | 'attention' | 'neutral';
export type TaskEventTerminalOutcome = 'none' | 'done' | 'failed';

const TASK_EVENT_LIFECYCLE_PHASES = [
    'startup',
    'preflight',
    'implementation',
    'validation',
    'review',
    'closeout',
    'terminal',
    'unknown'
] as const;
const TASK_EVENT_STATUS_SIGNALS = ['pass', 'fail', 'blocked', 'attention', 'info'] as const;
const TASK_EVENT_HEALTH_STATES = ['healthy', 'failed', 'blocked', 'attention', 'neutral'] as const;
const TASK_EVENT_TERMINAL_OUTCOMES = ['none', 'done', 'failed'] as const;

export interface TaskEventPublicMetadata {
    lifecycle_phase: TaskEventLifecyclePhase;
    status_signal: TaskEventStatusSignal;
    health_state: TaskEventHealthState;
    terminal_outcome: TaskEventTerminalOutcome;
}

export interface TaskEventIntegrityLike {
    schema_version?: unknown;
    task_sequence?: unknown;
    prev_event_sha256?: unknown;
    event_sha256?: unknown;
}

export interface TaskEventPublicRecord {
    schema_version: typeof TASK_EVENT_PUBLIC_SCHEMA_VERSION;
    event_source: typeof TASK_EVENT_PUBLIC_EVENT_SOURCE;
    timestamp_utc: string;
    task_id: string;
    event_type: string;
    outcome: string;
    actor: string;
    message: string;
    details: unknown;
    public_metadata: TaskEventPublicMetadata;
    integrity?: TaskEventIntegrityLike;
}

export interface NormalizedTaskEventPublicRecord extends TaskEventPublicRecord {
    source_schema_version: number;
    normalized_from_legacy: boolean;
    unknown_source_schema_version: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function readText(value: unknown): string {
    return value == null ? '' : String(value);
}

function readEnumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
    const normalized = readText(value).trim();
    return allowed.includes(normalized as T) ? (normalized as T) : null;
}

export function inferTaskEventLifecyclePhase(eventType: unknown): TaskEventLifecyclePhase {
    const normalized = readText(eventType).trim().toUpperCase();
    if (
        normalized === 'TASK_MODE_ENTERED'
        || normalized.startsWith('RULE_PACK_')
        || normalized === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
        || normalized === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
    ) {
        return 'startup';
    }
    if (normalized.startsWith('PREFLIGHT_')) {
        return 'preflight';
    }
    if (normalized === 'IMPLEMENTATION_STARTED') {
        return 'implementation';
    }
    if (
        normalized.startsWith('COMPILE_GATE_')
        || normalized.startsWith('FULL_SUITE_VALIDATION_')
        || normalized === 'QUALITY_CHECKLIST_RECORDED'
    ) {
        return 'validation';
    }
    if (normalized.startsWith('REVIEW_') || normalized.startsWith('REVIEWER_')) {
        return 'review';
    }
    if (
        normalized.startsWith('DOC_IMPACT_')
        || normalized.startsWith('PROJECT_MEMORY_IMPACT_')
        || normalized === 'NO_OP_RECORDED'
    ) {
        return 'closeout';
    }
    if (normalized.startsWith('COMPLETION_GATE_')) {
        return 'terminal';
    }
    return 'unknown';
}

export function inferTaskEventStatusSignal(eventType: unknown, outcome: unknown): TaskEventStatusSignal {
    const normalizedOutcome = readText(outcome).trim().toUpperCase();
    const normalizedEventType = readText(eventType).trim().toUpperCase();
    if (normalizedOutcome === 'FAIL' || normalizedOutcome === 'FAILED' || normalizedEventType.endsWith('_FAILED')) {
        return 'fail';
    }
    if (normalizedOutcome === 'BLOCKED' || normalizedEventType.endsWith('_BLOCKED')) {
        return 'blocked';
    }
    if (normalizedOutcome === 'WARN' || normalizedOutcome === 'WARNED' || normalizedOutcome === 'SKIPPED') {
        return 'attention';
    }
    if (normalizedOutcome === 'PASS' || normalizedOutcome === 'PASSED' || normalizedEventType.endsWith('_PASSED')) {
        return 'pass';
    }
    return 'info';
}

export function inferTaskEventHealthState(statusSignal: TaskEventStatusSignal): TaskEventHealthState {
    switch (statusSignal) {
        case 'pass':
            return 'healthy';
        case 'fail':
            return 'failed';
        case 'blocked':
            return 'blocked';
        case 'attention':
            return 'attention';
        default:
            return 'neutral';
    }
}

export function inferTaskEventTerminalOutcome(eventType: unknown): TaskEventTerminalOutcome {
    const normalized = readText(eventType).trim().toUpperCase();
    if (normalized === 'COMPLETION_GATE_PASSED') {
        return 'done';
    }
    if (normalized === 'COMPLETION_GATE_FAILED') {
        return 'failed';
    }
    return 'none';
}

export function buildTaskEventPublicMetadata(eventType: unknown, outcome: unknown): TaskEventPublicMetadata {
    const statusSignal = inferTaskEventStatusSignal(eventType, outcome);
    return {
        lifecycle_phase: inferTaskEventLifecyclePhase(eventType),
        status_signal: statusSignal,
        health_state: inferTaskEventHealthState(statusSignal),
        terminal_outcome: inferTaskEventTerminalOutcome(eventType)
    };
}

export function createTaskEventPublicRecord(input: Omit<TaskEventPublicRecord, 'schema_version' | 'event_source' | 'public_metadata'>): TaskEventPublicRecord {
    return {
        schema_version: TASK_EVENT_PUBLIC_SCHEMA_VERSION,
        event_source: TASK_EVENT_PUBLIC_EVENT_SOURCE,
        timestamp_utc: input.timestamp_utc,
        task_id: input.task_id,
        event_type: input.event_type,
        outcome: input.outcome,
        actor: input.actor,
        message: input.message,
        details: input.details,
        public_metadata: buildTaskEventPublicMetadata(input.event_type, input.outcome),
        integrity: input.integrity
    };
}

export function normalizeTaskEventPublicRecord(value: unknown): NormalizedTaskEventPublicRecord | null {
    if (!isRecord(value)) {
        return null;
    }

    const timestampUtc = readText(value.timestamp_utc).trim();
    const taskId = readText(value.task_id).trim();
    const eventType = readText(value.event_type).trim();
    if (!timestampUtc || !taskId || !eventType) {
        return null;
    }

    const sourceSchemaRaw = value.schema_version;
    const parsedSchemaVersion = typeof sourceSchemaRaw === 'number'
        ? sourceSchemaRaw
        : Number(sourceSchemaRaw);
    const hasNumericSchemaVersion = Number.isFinite(parsedSchemaVersion);
    const normalizedSourceSchemaVersion = hasNumericSchemaVersion && parsedSchemaVersion > 0
        ? parsedSchemaVersion
        : TASK_EVENT_LEGACY_SCHEMA_VERSION;
    const normalizedFromLegacy = !hasNumericSchemaVersion || normalizedSourceSchemaVersion === TASK_EVENT_LEGACY_SCHEMA_VERSION;
    const unknownSourceSchemaVersion =
        hasNumericSchemaVersion
        && normalizedSourceSchemaVersion !== TASK_EVENT_PUBLIC_SCHEMA_VERSION
        && normalizedSourceSchemaVersion !== TASK_EVENT_LEGACY_SCHEMA_VERSION;

    const fallbackMetadata = buildTaskEventPublicMetadata(eventType, value.outcome);
    const publicMetadataRecord = isRecord(value.public_metadata) ? value.public_metadata : {};

    return {
        schema_version: TASK_EVENT_PUBLIC_SCHEMA_VERSION,
        event_source: TASK_EVENT_PUBLIC_EVENT_SOURCE,
        timestamp_utc: timestampUtc,
        task_id: taskId,
        event_type: eventType,
        outcome: readText(value.outcome).trim() || 'UNKNOWN',
        actor: readText(value.actor).trim() || 'unknown',
        message: readText(value.message),
        details: Object.prototype.hasOwnProperty.call(value, 'details') ? value.details : null,
        public_metadata: {
            lifecycle_phase: readEnumValue(publicMetadataRecord.lifecycle_phase, TASK_EVENT_LIFECYCLE_PHASES) || fallbackMetadata.lifecycle_phase,
            status_signal: readEnumValue(publicMetadataRecord.status_signal, TASK_EVENT_STATUS_SIGNALS) || fallbackMetadata.status_signal,
            health_state: readEnumValue(publicMetadataRecord.health_state, TASK_EVENT_HEALTH_STATES) || fallbackMetadata.health_state,
            terminal_outcome: readEnumValue(publicMetadataRecord.terminal_outcome, TASK_EVENT_TERMINAL_OUTCOMES) || fallbackMetadata.terminal_outcome
        },
        integrity: isRecord(value.integrity) ? value.integrity : undefined,
        source_schema_version: normalizedSourceSchemaVersion,
        normalized_from_legacy: normalizedFromLegacy,
        unknown_source_schema_version: unknownSourceSchemaVersion
    };
}
