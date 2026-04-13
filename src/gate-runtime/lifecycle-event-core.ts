import * as fs from 'node:fs';
import * as path from 'node:path';
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

function getTimelinePath(repoRoot: string, taskId: string, eventsRoot?: string): string {
    const root = eventsRoot
        ? path.resolve(String(eventsRoot))
        : path.join(repoRoot, 'runtime', 'task-events');
    return path.join(root, `${taskId}.jsonl`);
}

function hasTaskEvent(repoRoot: string, taskId: string, eventType: string, eventsRoot?: string): boolean {
    if (!repoRoot || !taskId || !eventType) {
        return false;
    }
    const timelinePath = getTimelinePath(repoRoot, taskId, eventsRoot);
    const resolvedPath = path.resolve(timelinePath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return false;
    }

    try {
        const lines = fs.readFileSync(resolvedPath, 'utf8').split('\n');
        for (const rawLine of lines) {
            if (!rawLine.trim()) continue;
            try {
                const parsed = JSON.parse(rawLine) as Record<string, unknown>;
                if (String(parsed.event_type || '').trim().toUpperCase() === String(eventType).trim().toUpperCase()) {
                    return true;
                }
            } catch {
                // integrity inspection handles malformed lines elsewhere
            }
        }
    } catch {
        return false;
    }

    return false;
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
        if (emitOnce && hasTaskEvent(repoRoot, taskId, eventType, options.eventsRoot)) {
            return null;
        }
        return appendTaskEvent(
            repoRoot,
            taskId,
            eventType,
            outcome,
            message,
            details,
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot
            }
        );
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
        if (emitOnce && hasTaskEvent(repoRoot, taskId, eventType, options.eventsRoot)) {
            return null;
        }
        return await appendTaskEventAsync(
            repoRoot,
            taskId,
            eventType,
            outcome,
            message,
            details,
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot
            }
        );
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
    if (emitOnce && hasTaskEvent(repoRoot, taskId, eventType, options.eventsRoot)) {
        return null;
    }

    return appendMandatoryTaskEvent(
        repoRoot,
        taskId,
        eventType,
        outcome,
        message,
        details,
        {
            actor: options.actor || 'gate',
            eventsRoot: options.eventsRoot
        }
    );
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
    if (emitOnce && hasTaskEvent(repoRoot, taskId, eventType, options.eventsRoot)) {
        return null;
    }

    return appendMandatoryTaskEventAsync(
        repoRoot,
        taskId,
        eventType,
        outcome,
        message,
        details,
        {
            actor: options.actor || 'gate',
            eventsRoot: options.eventsRoot
        }
    );
}
