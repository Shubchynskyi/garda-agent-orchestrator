import * as path from 'node:path';

import {
    collectOrderedTimelineEvents,
    findLatestTimelineEvent,
    type TimelineEventEntry
} from '../../../../gates/completion/completion-evidence';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { resolveOrchestratorRoot } from '../compile/gate-flow-helpers';

const PRIOR_CYCLE_BOUNDARY_EVENTS = new Set([
    'IMPLEMENTATION_STARTED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'REVIEW_CYCLE_RESTARTED',
    'COMPLETION_GATE_FAILED',
    'COMPLETION_GATE_PASSED'
]);

export interface InterruptedCoherentCycleReadiness {
    ready: boolean;
    reason: string;
    failedShellSmokeSequence: number | null;
    passedShellSmokeSequence: number | null;
    compileSequence: number | null;
}

function eventPassed(entry: TimelineEventEntry): boolean {
    return entry.outcome === 'PASS' || entry.details?.passed === true;
}

function eventFailed(entry: TimelineEventEntry): boolean {
    return entry.outcome === 'FAIL' || entry.details?.passed === false;
}

function eventPathMatches(entry: TimelineEventEntry, key: string, expectedPath: string): boolean {
    const value = String(entry.details?.[key] || '').trim();
    return Boolean(value)
        && gateHelpers.normalizePath(path.resolve(value)) === gateHelpers.normalizePath(path.resolve(expectedPath));
}

function failure(reason: string): InterruptedCoherentCycleReadiness {
    return {
        ready: false,
        reason,
        failedShellSmokeSequence: null,
        passedShellSmokeSequence: null,
        compileSequence: null
    };
}

export function readInterruptedCoherentCycleReadiness(input: {
    repoRoot: string;
    taskId: string;
    taskModePath: string;
    preflightPath: string;
    compileEvidencePath: string;
}): InterruptedCoherentCycleReadiness {
    const timelinePath = path.join(
        resolveOrchestratorRoot(input.repoRoot),
        'runtime',
        'task-events',
        `${input.taskId}.jsonl`
    );
    const errors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, errors);
    if (errors.length > 0 || events.length === 0) {
        return failure('task timeline is missing or invalid');
    }

    const latestTaskMode = findLatestTimelineEvent(events, (entry) => entry.event_type === 'TASK_MODE_ENTERED');
    if (!latestTaskMode || !eventPassed(latestTaskMode) || !eventPathMatches(latestTaskMode, 'artifact_path', input.taskModePath)) {
        return failure('latest task-mode evidence does not match the current task-mode artifact');
    }
    const priorBoundary = findLatestTimelineEvent(
        events,
        (entry) => entry.sequence < latestTaskMode.sequence && PRIOR_CYCLE_BOUNDARY_EVENTS.has(entry.event_type)
    );
    if (!priorBoundary) {
        return failure('no prior lifecycle boundary proves that startup was part of a coherent-cycle restart');
    }

    const taskEntryRules = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'RULE_PACK_LOADED'
            && entry.sequence > latestTaskMode.sequence
            && String(entry.details?.stage || '').trim().toUpperCase() === 'TASK_ENTRY'
    );
    const handshake = taskEntryRules
        ? findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
                && entry.sequence > taskEntryRules.sequence
                && eventPassed(entry)
        )
        : null;
    if (!taskEntryRules || !handshake) {
        return failure('current task-mode cycle lacks passed TASK_ENTRY rules or handshake evidence');
    }

    const failedShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
            && entry.sequence > handshake.sequence
            && eventFailed(entry)
    );
    const passedShellSmoke = failedShellSmoke
        ? findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
                && entry.sequence > failedShellSmoke.sequence
                && eventPassed(entry)
        )
        : null;
    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
            && entry.sequence > handshake.sequence
    );
    if (!failedShellSmoke || !passedShellSmoke || latestShellSmoke?.sequence !== passedShellSmoke.sequence) {
        return failure('no failed-then-passed shell-smoke sequence proves recovery from an interrupted restart');
    }

    const preflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
            && entry.sequence > passedShellSmoke.sequence
            && eventPathMatches(entry, 'output_path', input.preflightPath)
    );
    const postPreflightRules = preflight
        ? findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'RULE_PACK_LOADED'
                && entry.sequence > preflight.sequence
                && String(entry.details?.stage || '').trim().toUpperCase() === 'POST_PREFLIGHT'
        )
        : null;
    const implementationStarted = postPreflightRules
        ? findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'IMPLEMENTATION_STARTED'
                && entry.sequence > postPreflightRules.sequence
        )
        : null;
    const compilePass = implementationStarted
        ? findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
                && entry.sequence > implementationStarted.sequence
                && eventPassed(entry)
                && eventPathMatches(entry, 'evidence_path', input.compileEvidencePath)
        )
        : null;
    if (!preflight || !postPreflightRules || !implementationStarted || !compilePass) {
        return failure('recovered startup is not followed by matching preflight, POST_PREFLIGHT rules, and compile evidence');
    }

    const laterRestartCompletion = findLatestTimelineEvent(
        events,
        (entry) => ['COHERENT_CYCLE_RESTARTED', 'REVIEW_CYCLE_RESTARTED'].includes(entry.event_type)
            && entry.sequence > compilePass.sequence
    );
    if (laterRestartCompletion) {
        return failure('restart completion is already recorded after the current compile evidence');
    }

    return {
        ready: true,
        reason: 'failed shell-smoke was retried successfully and current preflight/compile evidence completes the interrupted restart',
        failedShellSmokeSequence: failedShellSmoke.sequence,
        passedShellSmokeSequence: passedShellSmoke.sequence,
        compileSequence: compilePass.sequence
    };
}
