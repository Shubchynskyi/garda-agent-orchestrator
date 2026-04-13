import * as fs from 'node:fs';
import * as path from 'node:path';

export const LIFECYCLE_EVENT_TYPES = Object.freeze({
    TASK_MODE_ENTERED: 'TASK_MODE_ENTERED',
    PLAN_CREATED: 'PLAN_CREATED',
    RULE_PACK_LOADED: 'RULE_PACK_LOADED',
    RULE_PACK_LOAD_FAILED: 'RULE_PACK_LOAD_FAILED',
    PREFLIGHT_STARTED: 'PREFLIGHT_STARTED',
    PREFLIGHT_CLASSIFIED: 'PREFLIGHT_CLASSIFIED',
    PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
    IMPLEMENTATION_STARTED: 'IMPLEMENTATION_STARTED',
    COMPILE_GATE_PASSED: 'COMPILE_GATE_PASSED',
    COMPILE_GATE_FAILED: 'COMPILE_GATE_FAILED',
    REVIEW_PHASE_STARTED: 'REVIEW_PHASE_STARTED',
    REVIEW_GATE_PASSED: 'REVIEW_GATE_PASSED',
    REVIEW_GATE_PASSED_WITH_OVERRIDE: 'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    REVIEW_GATE_FAILED: 'REVIEW_GATE_FAILED',
    DOC_IMPACT_ASSESSED: 'DOC_IMPACT_ASSESSED',
    DOC_IMPACT_ASSESSMENT_FAILED: 'DOC_IMPACT_ASSESSMENT_FAILED',
    REVIEW_RECORDED: 'REVIEW_RECORDED',
    REVIEWER_DELEGATION_ROUTED: 'REVIEWER_DELEGATION_ROUTED',
    COMPLETION_GATE_PASSED: 'COMPLETION_GATE_PASSED',
    COMPLETION_GATE_FAILED: 'COMPLETION_GATE_FAILED',
    STATUS_CHANGED: 'STATUS_CHANGED',
    PROVIDER_ROUTING_DECISION: 'PROVIDER_ROUTING_DECISION',
    HANDSHAKE_DIAGNOSTICS_RECORDED: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
    SHELL_SMOKE_PREFLIGHT_RECORDED: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
    COMMAND_TIMEOUT_DIAGNOSTICS_RECORDED: 'COMMAND_TIMEOUT_DIAGNOSTICS_RECORDED'
});

export const MANDATORY_CODE_CHANGE_EVENTS: readonly string[] = Object.freeze([
    'TASK_MODE_ENTERED',
    'RULE_PACK_LOADED',
    'HANDSHAKE_DIAGNOSTICS_RECORDED',
    'SHELL_SMOKE_PREFLIGHT_RECORDED',
    'PREFLIGHT_CLASSIFIED',
    'IMPLEMENTATION_STARTED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'COMPLETION_GATE_PASSED'
]);

export const MANDATORY_NON_CODE_EVENTS: readonly string[] = Object.freeze([
    'TASK_MODE_ENTERED',
    'RULE_PACK_LOADED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'COMPLETION_GATE_PASSED'
]);

export function getMandatoryEvents(codeChanged: boolean): readonly string[] {
    return codeChanged ? MANDATORY_CODE_CHANGE_EVENTS : MANDATORY_NON_CODE_EVENTS;
}

export interface TimelineCompletenessResult {
    task_id: string;
    timeline_path: string;
    timeline_exists: boolean;
    events_found: string[];
    events_missing: string[];
    status: 'COMPLETE' | 'INCOMPLETE' | 'MISSING_TIMELINE';
    violations: string[];
}

export function validateTimelineCompleteness(
    timelinePath: string,
    taskId: string,
    codeChanged: boolean
): TimelineCompletenessResult {
    const normalizedPath = timelinePath.replace(/\\/g, '/');
    const result: TimelineCompletenessResult = {
        task_id: taskId,
        timeline_path: normalizedPath,
        timeline_exists: false,
        events_found: [],
        events_missing: [],
        status: 'MISSING_TIMELINE',
        violations: []
    };

    const resolvedPath = path.resolve(timelinePath);
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.violations.push(`Task timeline not found for '${taskId}': ${normalizedPath}`);
        return result;
    }

    result.timeline_exists = true;
    const eventTypes = new Set<string>();

    try {
        const content = fs.readFileSync(resolvedPath, 'utf8');
        for (const rawLine of content.split('\n')) {
            if (!rawLine.trim()) continue;
            try {
                const parsed = JSON.parse(rawLine) as Record<string, unknown>;
                const eventType = String(parsed.event_type || '').trim().toUpperCase();
                if (eventType) {
                    eventTypes.add(eventType);
                }
            } catch {
                // integrity inspection handles malformed lines elsewhere
            }
        }
    } catch {
        result.violations.push(`Task timeline unreadable for '${taskId}': ${normalizedPath}`);
        return result;
    }

    const mandatory = getMandatoryEvents(codeChanged);
    for (const expectedEvent of mandatory) {
        if (expectedEvent === 'REVIEW_GATE_PASSED') {
            if (eventTypes.has('REVIEW_GATE_PASSED') || eventTypes.has('REVIEW_GATE_PASSED_WITH_OVERRIDE')) {
                result.events_found.push(expectedEvent);
            } else {
                result.events_missing.push(expectedEvent);
                result.violations.push(
                    `Task timeline '${normalizedPath}' is missing mandatory lifecycle event: ${expectedEvent}.`
                );
            }
            continue;
        }

        if (eventTypes.has(expectedEvent)) {
            result.events_found.push(expectedEvent);
        } else {
            result.events_missing.push(expectedEvent);
            result.violations.push(
                `Task timeline '${normalizedPath}' is missing mandatory lifecycle event: ${expectedEvent}.`
            );
        }
    }

    result.status = result.events_missing.length > 0 ? 'INCOMPLETE' : 'COMPLETE';
    return result;
}
