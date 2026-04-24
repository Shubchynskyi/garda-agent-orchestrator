import {
    appendMandatoryTaskEvent,
    appendMandatoryTaskEventAsync,
    appendTaskEvent,
    appendTaskEventAsync
} from './task-events';

export interface AutoEmitOptions {
    actor?: string;
    passThru?: boolean;
    eventsRoot?: string;
}

export function emitLifecycleEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome: string,
    message: string,
    details: unknown,
    options: AutoEmitOptions = {},
    emitOnce = false
): ReturnType<typeof appendTaskEvent> {
    if (!repoRoot || !taskId) {
        return null;
    }
    try {
        const result = appendTaskEvent(
            repoRoot,
            taskId,
            eventType,
            outcome,
            message,
            details,
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot,
                emitOnce
            }
        );
        if (result && result.skipped_reason === 'emit_once_duplicate') {
            return null;
        }
        return result;
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`WARNING: ${String(eventType).toLowerCase()} event emit failed: ${msg}\n`);
        return null;
    }
}

export async function emitLifecycleEventAsync(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome: string,
    message: string,
    details: unknown,
    options: AutoEmitOptions = {},
    emitOnce = false
): Promise<ReturnType<typeof appendTaskEvent>> {
    if (!repoRoot || !taskId) {
        return null;
    }
    try {
        const result = await appendTaskEventAsync(
            repoRoot,
            taskId,
            eventType,
            outcome,
            message,
            details,
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot,
                emitOnce
            }
        );
        if (result && result.skipped_reason === 'emit_once_duplicate') {
            return null;
        }
        return result;
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`WARNING: ${String(eventType).toLowerCase()} event emit failed: ${msg}\n`);
        return null;
    }
}

export function emitMandatoryLifecycleEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome: string,
    message: string,
    details: unknown,
    options: AutoEmitOptions = {},
    emitOnce = false
): ReturnType<typeof appendTaskEvent> {
    if (!repoRoot || !taskId) {
        throw new Error(`Mandatory lifecycle event '${eventType}' requires repoRoot and taskId.`);
    }

    const result = appendMandatoryTaskEvent(
        repoRoot,
        taskId,
        eventType,
        outcome,
        message,
        details,
        {
            actor: options.actor || 'gate',
            eventsRoot: options.eventsRoot,
            emitOnce
        }
    );

    if (result.skipped_reason === 'emit_once_duplicate') {
        return null;
    }
    return result;
}

export async function emitMandatoryLifecycleEventAsync(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome: string,
    message: string,
    details: unknown,
    options: AutoEmitOptions = {},
    emitOnce = false
): Promise<ReturnType<typeof appendTaskEvent>> {
    if (!repoRoot || !taskId) {
        throw new Error(`Mandatory lifecycle event '${eventType}' requires repoRoot and taskId.`);
    }

    const result = await appendMandatoryTaskEventAsync(
        repoRoot,
        taskId,
        eventType,
        outcome,
        message,
        details,
        {
            actor: options.actor || 'gate',
            eventsRoot: options.eventsRoot,
            emitOnce
        }
    );

    if (result.skipped_reason === 'emit_once_duplicate') {
        return null;
    }
    return result;
}
