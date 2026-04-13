import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertValidTaskId } from '../gate-runtime/task-events';
import { fileSha256, joinOrchestratorPath, normalizePath, resolvePathInsideRepo } from './helpers';

export const TASK_MODE_ENTRY_MODES = Object.freeze([
    'EXPLICIT_TASK_EXECUTION',
    'TASK_CREATED_FROM_REQUEST'
] as const);

export type TaskModeEntryMode = (typeof TASK_MODE_ENTRY_MODES)[number];

const TASK_MODE_ENTRY_MODE_ALIASES = Object.freeze({
    explicit: 'EXPLICIT_TASK_EXECUTION',
    explicit_task_execution: 'EXPLICIT_TASK_EXECUTION',
    explicitexecute: 'EXPLICIT_TASK_EXECUTION',
    execute: 'EXPLICIT_TASK_EXECUTION',
    task_created_from_request: 'TASK_CREATED_FROM_REQUEST',
    taskcreatedfromrequest: 'TASK_CREATED_FROM_REQUEST',
    transparent_task_creation: 'TASK_CREATED_FROM_REQUEST',
    transparenttaskcreation: 'TASK_CREATED_FROM_REQUEST',
    create: 'TASK_CREATED_FROM_REQUEST',
    created: 'TASK_CREATED_FROM_REQUEST'
} satisfies Record<string, TaskModeEntryMode>);

export interface TaskModePlanMetadata {
    plan_path: string;
    plan_sha256: string;
    plan_summary: string;
}

export interface TaskModeArtifact {
    timestamp_utc: string;
    event_source: 'enter-task-mode';
    task_id: string;
    status: 'PASSED';
    outcome: 'PASS';
    entry_mode: TaskModeEntryMode;
    requested_depth: number;
    effective_depth: number;
    task_summary: string;
    orchestrator_work: boolean;
    provider: string | null;
    routed_to: string | null;
    actor: string;
    plan: TaskModePlanMetadata | null;
    active_profile: string | null;
    profile_source: 'built_in' | 'user' | null;
}

export interface BuildTaskModeArtifactOptions {
    taskId: string;
    entryMode: unknown;
    requestedDepth: unknown;
    effectiveDepth: unknown;
    taskSummary: string;
    orchestratorWork?: boolean;
    provider?: string | null;
    routedTo?: string | null;
    actor?: string;
    plan?: TaskModePlanMetadata | null;
    activeProfile?: string | null;
    profileSource?: 'built_in' | 'user' | null;
}

export interface TaskModeEvidenceResult {
    task_id: string | null;
    evidence_path: string | null;
    evidence_hash: string | null;
    evidence_status: string;
    evidence_outcome: string | null;
    evidence_task_id: string | null;
    evidence_source: string | null;
    entry_mode: string | null;
    requested_depth: number | null;
    effective_depth: number | null;
    task_summary: string | null;
    orchestrator_work: boolean | null;
    provider: string | null;
    routed_to: string | null;
    plan: TaskModePlanMetadata | null;
    active_profile: string | null;
    profile_source: string | null;
}

export function normalizeTaskModeEntryMode(value: unknown): TaskModeEntryMode {
    const raw = String(value || '').trim();
    if (!raw) {
        return 'EXPLICIT_TASK_EXECUTION';
    }
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
    const aliasMatch = TASK_MODE_ENTRY_MODE_ALIASES[normalized as keyof typeof TASK_MODE_ENTRY_MODE_ALIASES];
    if (aliasMatch) {
        return aliasMatch;
    }

    const canonicalMatch = TASK_MODE_ENTRY_MODES.find(function (mode) {
        return mode.toLowerCase() === normalized;
    });
    if (canonicalMatch) {
        return canonicalMatch;
    }

    throw new Error(
        `EntryMode must be one of: ${TASK_MODE_ENTRY_MODES.join(', ')}. ` +
        "Supported aliases: explicit, explicit_task_execution, task_created_from_request, transparent_task_creation."
    );
}

export function parseTaskModeDepth(value: unknown, label: string, fallback: number): number {
    if (value == null || String(value).trim() === '') {
        return fallback;
    }
    const parsed = Number.parseInt(String(value).trim(), 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
        throw new Error(`${label} must be an integer between 1 and 3. Got '${value}'.`);
    }
    return parsed;
}

export function resolveTaskModeArtifactPath(repoRoot: string, taskId: string, artifactPath: string): string {
    const explicitPath = String(artifactPath || '').trim();
    if (explicitPath) {
        const resolvedPath = resolvePathInsideRepo(explicitPath, repoRoot, { allowMissing: true });
        if (!resolvedPath) {
            throw new Error('TaskModeArtifactPath must not be empty.');
        }
        return resolvedPath;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-task-mode.json`));
}

export function buildTaskModeArtifact(options: BuildTaskModeArtifactOptions): TaskModeArtifact {
    const taskId = assertValidTaskId(options.taskId);
    const entryMode = normalizeTaskModeEntryMode(options.entryMode);
    const requestedDepth = parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', 2);
    const effectiveDepth = parseTaskModeDepth(options.effectiveDepth, 'EffectiveDepth', requestedDepth);
    const taskSummary = String(options.taskSummary || '').trim();
    if (taskSummary.length < 8) {
        throw new Error('TaskSummary is required (>= 8 characters).');
    }

    const actor = String(options.actor || 'orchestrator').trim() || 'orchestrator';
    const plan = options.plan && options.plan.plan_path && options.plan.plan_sha256 && options.plan.plan_summary
        ? {
            plan_path: options.plan.plan_path,
            plan_sha256: options.plan.plan_sha256,
            plan_summary: options.plan.plan_summary
        }
        : null;
    return {
        timestamp_utc: new Date().toISOString(),
        event_source: 'enter-task-mode',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        entry_mode: entryMode,
        requested_depth: requestedDepth,
        effective_depth: effectiveDepth,
        task_summary: taskSummary,
        orchestrator_work: !!options.orchestratorWork,
        provider: String(options.provider || '').trim() || null,
        routed_to: String(options.routedTo || '').trim() || null,
        actor,
        plan,
        active_profile: String(options.activeProfile || '').trim() || null,
        profile_source: options.profileSource || null
    };
}

export function getTaskModeEvidence(repoRoot: string, taskId: string | null, artifactPath = ''): TaskModeEvidenceResult {
    const result: TaskModeEvidenceResult = {
        task_id: taskId,
        evidence_path: null,
        evidence_hash: null,
        evidence_status: 'UNKNOWN',
        evidence_outcome: null,
        evidence_task_id: null,
        evidence_source: null,
        entry_mode: null,
        requested_depth: null,
        effective_depth: null,
        task_summary: null,
        orchestrator_work: null,
        provider: null,
        routed_to: null,
        plan: null,
        active_profile: null,
        profile_source: null
    };

    if (!taskId) {
        result.evidence_status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedTaskId = assertValidTaskId(taskId);
    const resolvedPath = resolveTaskModeArtifactPath(repoRoot, resolvedTaskId, artifactPath);
    result.evidence_path = normalizePath(resolvedPath);

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.evidence_status = 'EVIDENCE_FILE_MISSING';
        return result;
    }

    let artifactObject: Record<string, unknown>;
    try {
        artifactObject = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
    } catch {
        result.evidence_status = 'EVIDENCE_INVALID_JSON';
        return result;
    }

    result.evidence_hash = fileSha256(resolvedPath);
    result.evidence_status = String(artifactObject.status || '').trim().toUpperCase();
    result.evidence_outcome = String(artifactObject.outcome || '').trim().toUpperCase();
    result.evidence_task_id = String(artifactObject.task_id || '').trim() || null;
    result.evidence_source = String(artifactObject.event_source || '').trim() || null;
    result.entry_mode = String(artifactObject.entry_mode || '').trim() || null;
    result.task_summary = String(artifactObject.task_summary || '').trim() || null;
    result.orchestrator_work = typeof artifactObject.orchestrator_work === 'boolean' ? artifactObject.orchestrator_work : null;
    result.provider = String(artifactObject.provider || '').trim() || null;
    result.routed_to = String(artifactObject.routed_to || '').trim() || null;

    // Extract optional plan metadata
    const rawPlan = artifactObject.plan;
    if (rawPlan && typeof rawPlan === 'object' && !Array.isArray(rawPlan)) {
        const planObj = rawPlan as Record<string, unknown>;
        const planPath = String(planObj.plan_path || '').trim();
        const planSha256 = String(planObj.plan_sha256 || '').trim();
        const planSummary = String(planObj.plan_summary || '').trim();
        if (planPath && planSha256 && planSummary) {
            result.plan = { plan_path: planPath, plan_sha256: planSha256, plan_summary: planSummary };
        }
    }

    // Extract optional profile metadata
    result.active_profile = String(artifactObject.active_profile || '').trim() || null;
    result.profile_source = String(artifactObject.profile_source || '').trim() || null;

    const requestedDepth = artifactObject.requested_depth;
    if (typeof requestedDepth === 'number' && Number.isInteger(requestedDepth)) {
        result.requested_depth = requestedDepth;
    }
    const effectiveDepth = artifactObject.effective_depth;
    if (typeof effectiveDepth === 'number' && Number.isInteger(effectiveDepth)) {
        result.effective_depth = effectiveDepth;
    }

    if (result.evidence_task_id !== resolvedTaskId) {
        result.evidence_status = 'EVIDENCE_TASK_MISMATCH';
        return result;
    }
    if ((result.evidence_source || '').toLowerCase() !== 'enter-task-mode') {
        result.evidence_status = 'EVIDENCE_SOURCE_INVALID';
        return result;
    }
    if (!result.entry_mode || !TASK_MODE_ENTRY_MODES.includes(result.entry_mode as TaskModeEntryMode)) {
        result.evidence_status = 'EVIDENCE_ENTRY_MODE_INVALID';
        return result;
    }
    if (!result.requested_depth || result.requested_depth < 1 || result.requested_depth > 3) {
        result.evidence_status = 'EVIDENCE_REQUESTED_DEPTH_INVALID';
        return result;
    }
    if (!result.effective_depth || result.effective_depth < 1 || result.effective_depth > 3) {
        result.evidence_status = 'EVIDENCE_EFFECTIVE_DEPTH_INVALID';
        return result;
    }
    if (!result.task_summary || result.task_summary.length < 8) {
        result.evidence_status = 'EVIDENCE_SUMMARY_INVALID';
        return result;
    }
    if (result.evidence_status === 'PASSED' && result.evidence_outcome === 'PASS') {
        result.evidence_status = 'PASS';
        return result;
    }

    result.evidence_status = 'EVIDENCE_NOT_PASS';
    return result;
}

export function getTaskModeEvidenceViolations(result: TaskModeEvidenceResult): string[] {
    const evidencePath = result.evidence_path || '<missing>';
    switch (result.evidence_status) {
        case 'PASS':
            return [];
        case 'TASK_ID_MISSING':
            return ['Task-mode entry evidence cannot be verified: task id is missing.'];
        case 'EVIDENCE_FILE_MISSING':
            return [
                `Task-mode entry evidence missing: file not found at '${evidencePath}'. ` +
                'Run enter-task-mode before preflight/compile/review/completion gates.'
            ];
        case 'EVIDENCE_INVALID_JSON':
            return [`Task-mode entry evidence is invalid JSON at '${evidencePath}'. Re-run enter-task-mode.`];
        case 'EVIDENCE_TASK_MISMATCH':
            return [
                `Task-mode entry evidence task mismatch. Expected '${result.task_id}', got '${result.evidence_task_id}'.`
            ];
        case 'EVIDENCE_SOURCE_INVALID':
            return [
                `Task-mode entry evidence source is invalid. Expected 'enter-task-mode', got '${result.evidence_source}'.`
            ];
        case 'EVIDENCE_ENTRY_MODE_INVALID':
            return [
                `Task-mode entry evidence has invalid entry_mode '${result.entry_mode}'. ` +
                `Allowed values: ${TASK_MODE_ENTRY_MODES.join(', ')}.`
            ];
        case 'EVIDENCE_REQUESTED_DEPTH_INVALID':
            return ['Task-mode entry evidence is missing a valid requested_depth (1..3).'];
        case 'EVIDENCE_EFFECTIVE_DEPTH_INVALID':
            return ['Task-mode entry evidence is missing a valid effective_depth (1..3).'];
        case 'EVIDENCE_SUMMARY_INVALID':
            return ['Task-mode entry evidence is missing a usable task_summary (>= 8 chars).'];
        case 'EVIDENCE_NOT_PASS':
            return [
                `Task-mode entry evidence must be PASSED/PASS, got status='${result.evidence_status}', outcome='${result.evidence_outcome}'.`
            ];
        default:
            return ['Task-mode entry evidence is missing or invalid. Re-run enter-task-mode.'];
    }
}

export function collectTaskTimelineEventTypes(timelinePath: string, errors: string[]): Set<string> {
    const eventTypes = new Set<string>();
    const resolvedPath = path.resolve(String(timelinePath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        errors.push(`Task timeline not found: ${normalizePath(resolvedPath)}`);
        return eventTypes;
    }

    const lines = fs.readFileSync(resolvedPath, 'utf8').split('\n').filter(function (line: string) {
        return line.trim().length > 0;
    });
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            if (eventType) {
                eventTypes.add(eventType);
            }
        } catch {
            errors.push(`Task timeline contains invalid JSON line: ${normalizePath(resolvedPath)}`);
            break;
        }
    }

    return eventTypes;
}
