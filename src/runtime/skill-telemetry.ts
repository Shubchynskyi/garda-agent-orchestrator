import { appendTaskEvent, appendTaskEventAsync } from '../gate-runtime/task-events';

/**
 * Telemetry event types for skill activation and reference loading.
 * Used by the runtime task-event stream to track which skills and
 * references were suggested, selected, or loaded during a task.
 */
export const SKILL_TELEMETRY_EVENT_TYPES = Object.freeze({
    SKILL_SUGGESTED: 'SKILL_SUGGESTED',
    SKILL_SELECTED: 'SKILL_SELECTED',
    SKILL_REFERENCE_LOADED: 'SKILL_REFERENCE_LOADED'
});

export const SKILL_TELEMETRY_ACTOR = 'skill-telemetry';

type SkillTelemetryAppendOptions = NonNullable<Parameters<typeof appendTaskEvent>[6]>;
type SkillTelemetryResult = ReturnType<typeof appendTaskEvent>;
type SkillTelemetryEventType = typeof SKILL_TELEMETRY_EVENT_TYPES[keyof typeof SKILL_TELEMETRY_EVENT_TYPES];

interface SignalMatchesLike {
    stack_signals?: string[];
    task_signals?: string[];
    changed_path_signals?: string[];
    project_path_signals?: string[];
    aliases_or_tags?: string[];
}

type TelemetryMatches = string[] | SignalMatchesLike;

interface SkillTelemetryDetailOptions {
    skillId?: string | null;
    referencePath?: string | null;
    triggerReason?: string | null;
    score?: number;
    packId?: string | null;
    matches?: TelemetryMatches | null;
}

interface SkillTelemetryDetails {
    telemetry_type: 'skill_activation';
    skill_id: string | null;
    reference_path: string | null;
    trigger_reason: string | null;
    score?: number;
    pack_id?: string;
    matches?: TelemetryMatches;
}

interface SkillSuggestionTelemetry {
    id?: string | null;
    pack?: string | null;
    score?: number | null;
    matches?: TelemetryMatches | null;
}

export function buildSkillTelemetryDetails(options: SkillTelemetryDetailOptions): SkillTelemetryDetails {
    const details: SkillTelemetryDetails = {
        telemetry_type: 'skill_activation',
        skill_id: options.skillId || null,
        reference_path: options.referencePath || null,
        trigger_reason: options.triggerReason || null
    };

    if (typeof options.score === 'number') {
        details.score = options.score;
    }
    if (options.packId) {
        details.pack_id = options.packId;
    }
    if (options.matches) {
        if (Array.isArray(options.matches)) {
            details.matches = [...options.matches];
        } else {
            details.matches = Object.assign({}, options.matches);
        }
    }

    return details;
}

/**
 * Core emit helper. Wraps appendTaskEvent with non-blocking semantics:
 * errors are caught and logged to stderr, never propagated.
 */
export function emitSkillTelemetryEvent(
    bundleRoot: string | null | undefined,
    taskId: string | null | undefined,
    eventType: SkillTelemetryEventType,
    message: string,
    detailOptions: SkillTelemetryDetailOptions = {},
    appendOptions?: SkillTelemetryAppendOptions
): SkillTelemetryResult {
    if (!bundleRoot || !taskId) {
        return null;
    }

    const details = buildSkillTelemetryDetails(detailOptions);

    try {
        return appendTaskEvent(
            bundleRoot,
            taskId,
            eventType,
            'INFO',
            message,
            details,
            Object.assign({ actor: SKILL_TELEMETRY_ACTOR }, appendOptions || {})
        );
    } catch (error: unknown) {
        try {
            const errorMessage = error instanceof Error ? error.message : String(error);
            process.stderr.write(
                `WARNING: skill-telemetry emit failed: ${errorMessage}\n`
            );
        } catch {
            // swallow
        }
        return null;
    }
}

export async function emitSkillTelemetryEventAsync(
    bundleRoot: string | null | undefined,
    taskId: string | null | undefined,
    eventType: SkillTelemetryEventType,
    message: string,
    detailOptions: SkillTelemetryDetailOptions = {},
    appendOptions?: SkillTelemetryAppendOptions
): Promise<SkillTelemetryResult> {
    if (!bundleRoot || !taskId) {
        return null;
    }

    const details = buildSkillTelemetryDetails(detailOptions);

    try {
        return await appendTaskEventAsync(
            bundleRoot,
            taskId,
            eventType,
            'INFO',
            message,
            details,
            Object.assign({ actor: SKILL_TELEMETRY_ACTOR }, appendOptions || {})
        );
    } catch (error: unknown) {
        try {
            const errorMessage = error instanceof Error ? error.message : String(error);
            process.stderr.write(
                `WARNING: skill-telemetry emit failed: ${errorMessage}\n`
            );
        } catch {
            // swallow
        }
        return null;
    }
}

export function emitSkillSuggestedEvent(
    bundleRoot: string | null | undefined,
    taskId: string | null | undefined,
    suggestion: SkillSuggestionTelemetry | null | undefined,
    triggerReason?: string | null,
    appendOptions?: SkillTelemetryAppendOptions
): SkillTelemetryResult {
    return emitSkillTelemetryEvent(
        bundleRoot,
        taskId,
        SKILL_TELEMETRY_EVENT_TYPES.SKILL_SUGGESTED,
        `Skill suggested: ${suggestion && suggestion.id}`,
        {
            skillId: suggestion && suggestion.id,
            packId: (suggestion && suggestion.pack) || null,
            triggerReason: triggerReason || 'context_match',
            score: typeof suggestion?.score === 'number' ? suggestion.score : undefined,
            matches: suggestion?.matches
                ? (Array.isArray(suggestion.matches)
                    ? suggestion.matches.map((value: unknown) => String(value))
                    : suggestion.matches)
                : null
        },
        appendOptions
    );
}

export function emitSkillSelectedEvent(
    bundleRoot: string | null | undefined,
    taskId: string | null | undefined,
    skillId: string,
    packId?: string | null,
    triggerReason?: string | null,
    appendOptions?: SkillTelemetryAppendOptions
): SkillTelemetryResult {
    return emitSkillTelemetryEvent(
        bundleRoot,
        taskId,
        SKILL_TELEMETRY_EVENT_TYPES.SKILL_SELECTED,
        `Skill selected: ${skillId}`,
        {
            skillId: skillId,
            packId: packId || null,
            triggerReason: triggerReason || 'user_selected'
        },
        appendOptions
    );
}

export async function emitSkillSelectedEventAsync(
    bundleRoot: string | null | undefined,
    taskId: string | null | undefined,
    skillId: string,
    packId?: string | null,
    triggerReason?: string | null,
    appendOptions?: SkillTelemetryAppendOptions
): Promise<SkillTelemetryResult> {
    return emitSkillTelemetryEventAsync(
        bundleRoot,
        taskId,
        SKILL_TELEMETRY_EVENT_TYPES.SKILL_SELECTED,
        `Skill selected: ${skillId}`,
        {
            skillId: skillId,
            packId: packId || null,
            triggerReason: triggerReason || 'user_selected'
        },
        appendOptions
    );
}

export function emitSkillReferenceLoadedEvent(
    bundleRoot: string | null | undefined,
    taskId: string | null | undefined,
    referencePath: string,
    skillId?: string | null,
    triggerReason?: string | null,
    appendOptions?: SkillTelemetryAppendOptions
): SkillTelemetryResult {
    return emitSkillTelemetryEvent(
        bundleRoot,
        taskId,
        SKILL_TELEMETRY_EVENT_TYPES.SKILL_REFERENCE_LOADED,
        `Reference loaded: ${referencePath}`,
        {
            skillId: skillId || null,
            referencePath: referencePath,
            triggerReason: triggerReason || 'bridge_route'
        },
        appendOptions
    );
}

export async function emitSkillReferenceLoadedEventAsync(
    bundleRoot: string | null | undefined,
    taskId: string | null | undefined,
    referencePath: string,
    skillId?: string | null,
    triggerReason?: string | null,
    appendOptions?: SkillTelemetryAppendOptions
): Promise<SkillTelemetryResult> {
    return emitSkillTelemetryEventAsync(
        bundleRoot,
        taskId,
        SKILL_TELEMETRY_EVENT_TYPES.SKILL_REFERENCE_LOADED,
        `Reference loaded: ${referencePath}`,
        {
            skillId: skillId || null,
            referencePath: referencePath,
            triggerReason: triggerReason || 'bridge_route'
        },
        appendOptions
    );
}
