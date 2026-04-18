import * as fs from 'node:fs';
import * as path from 'node:path';

import { SOURCE_OF_TRUTH_VALUES } from '../core/constants';
import { assertValidTaskId } from '../gate-runtime/task-events';
import { getCanonicalEntrypointFile, getProviderOrchestratorProfileDefinitions } from '../materialization/common';
import {
    normalizeDirtyWorkspaceBaseline,
    type DirtyWorkspaceBaseline
} from './dirty-worktree-protection';
import { fileSha256, joinOrchestratorPath, normalizePath, resolvePathInsideRepo } from './helpers';

export const TASK_MODE_ENTRY_MODES = Object.freeze([
    'EXPLICIT_TASK_EXECUTION',
    'TASK_CREATED_FROM_REQUEST'
] as const);

const TASK_MODE_ENTRY_EXECUTION_PROVIDER_SOURCES = Object.freeze([
    'provider_bridge',
    'provider_entrypoint',
    'explicit_provider'
] as const);

const TASK_MODE_RUNTIME_IDENTITY_STATUSES = Object.freeze([
    'resolved',
    'legacy_fallback',
    'missing',
    'contradictory'
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
    canonical_source_of_truth: string | null;
    execution_provider_source: string | null;
    reviewer_capability_level: string | null;
    reviewer_expected_execution_mode: string | null;
    reviewer_fallback_allowed: boolean | null;
    reviewer_fallback_reason_required: boolean | null;
    runtime_identity_status: string | null;
    runtime_identity_violations: string[];
    routed_to: string | null;
    actor: string;
    plan: TaskModePlanMetadata | null;
    active_profile: string | null;
    profile_source: 'built_in' | 'user' | null;
    dirty_workspace_baseline: DirtyWorkspaceBaseline | null;
}

export interface BuildTaskModeArtifactOptions {
    taskId: string;
    entryMode: unknown;
    requestedDepth: unknown;
    effectiveDepth: unknown;
    taskSummary: string;
    orchestratorWork?: boolean;
    provider?: string | null;
    canonicalSourceOfTruth?: string | null;
    executionProviderSource?: string | null;
    reviewerCapabilityLevel?: string | null;
    reviewerExpectedExecutionMode?: string | null;
    reviewerFallbackAllowed?: boolean | null;
    reviewerFallbackReasonRequired?: boolean | null;
    runtimeIdentityStatus?: string | null;
    runtimeIdentityViolations?: string[] | null;
    routedTo?: string | null;
    actor?: string;
    plan?: TaskModePlanMetadata | null;
    activeProfile?: string | null;
    profileSource?: 'built_in' | 'user' | null;
    dirtyWorkspaceBaseline?: DirtyWorkspaceBaseline | null;
}

export interface TaskModeEvidenceResult {
    task_id: string | null;
    evidence_path: string | null;
    timeline_artifact_path: string | null;
    timeline_declares_runtime_identity_metadata: boolean;
    evidence_hash: string | null;
    declares_runtime_identity_metadata: boolean;
    identity_backfilled_from_legacy: boolean;
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
    canonical_source_of_truth: string | null;
    execution_provider_source: string | null;
    reviewer_capability_level: string | null;
    reviewer_expected_execution_mode: string | null;
    reviewer_fallback_allowed: boolean | null;
    reviewer_fallback_reason_required: boolean | null;
    runtime_identity_status: string | null;
    runtime_identity_violations: string[];
    routed_to: string | null;
    plan: TaskModePlanMetadata | null;
    active_profile: string | null;
    profile_source: string | null;
    dirty_workspace_baseline: DirtyWorkspaceBaseline | null;
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

function getTaskTimelinePath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
}

function getLatestTaskModeTimelineMetadata(repoRoot: string, taskId: string): {
    artifact_path: string | null;
    declares_runtime_identity_metadata: boolean;
} {
    const timelinePath = getTaskTimelinePath(repoRoot, taskId);
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return {
            artifact_path: null,
            declares_runtime_identity_metadata: false
        };
    }

    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter(function (line) {
            return line.trim().length > 0;
        });
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(parsed.event_type || '').trim().toUpperCase() !== 'TASK_MODE_ENTERED') {
                continue;
            }
            const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                ? parsed.details as Record<string, unknown>
                : null;
            const artifactPath = String(details?.artifact_path || details?.artifactPath || '').trim();
            const declaresRuntimeIdentityMetadata = [
                'canonical_source_of_truth',
                'execution_provider_source',
                'reviewer_capability_level',
                'reviewer_expected_execution_mode',
                'reviewer_fallback_allowed',
                'reviewer_fallback_reason_required',
                'runtime_identity_status',
                'runtime_identity_violations'
            ].some((key) => Object.prototype.hasOwnProperty.call(details || {}, key));
            return {
                artifact_path: artifactPath ? normalizePath(artifactPath) : null,
                declares_runtime_identity_metadata: declaresRuntimeIdentityMetadata
            };
        } catch {
            return {
                artifact_path: null,
                declares_runtime_identity_metadata: false
            };
        }
    }

    return {
        artifact_path: null,
        declares_runtime_identity_metadata: false
    };
}

function normalizeLegacySourceOfTruthValue(value: unknown): string | null {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    const normalizedInput = text.toLowerCase().replace(/[\s_-]+/g, '');
    const match = SOURCE_OF_TRUTH_VALUES.find((candidate) => (
        candidate.toLowerCase().replace(/[\s_-]+/g, '') === normalizedInput
    ));
    return match || null;
}

function normalizeLegacyRoutePath(value: unknown): string | null {
    const text = String(value || '').trim().replace(/\\/g, '/');
    if (!text) {
        return null;
    }
    return text.replace(/^\.\//, '');
}

function readLegacyCanonicalSourceOfTruth(repoRoot: string): string | null {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const initAnswersPath = joinOrchestratorPath(normalizedRepoRoot, path.join('runtime', 'init-answers.json'));
    if (fs.existsSync(initAnswersPath) && fs.statSync(initAnswersPath).isFile()) {
        try {
            const initAnswers = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
            const sourceOfTruth = normalizeLegacySourceOfTruthValue(initAnswers.SourceOfTruth);
            if (sourceOfTruth) {
                return sourceOfTruth;
            }
        } catch {
            // Legacy compatibility fallback only.
        }
    }

    const liveVersionPath = joinOrchestratorPath(normalizedRepoRoot, path.join('live', 'version.json'));
    if (fs.existsSync(liveVersionPath) && fs.statSync(liveVersionPath).isFile()) {
        try {
            const liveVersion = JSON.parse(fs.readFileSync(liveVersionPath, 'utf8')) as Record<string, unknown>;
            return normalizeLegacySourceOfTruthValue(liveVersion.SourceOfTruth);
        } catch {
            // Legacy compatibility fallback only.
        }
    }

    return null;
}

function resolveLegacyRouteIdentity(routedTo: string | null): {
    provider: string | null;
    routeKind: 'provider_bridge' | 'provider_entrypoint' | null;
} {
    const normalizedRoute = normalizeLegacyRoutePath(routedTo);
    if (!normalizedRoute) {
        return {
            provider: null,
            routeKind: null
        };
    }

    for (const profile of getProviderOrchestratorProfileDefinitions()) {
        if (normalizeLegacyRoutePath(profile.orchestratorRelativePath) === normalizedRoute) {
            return {
                provider: normalizeLegacySourceOfTruthValue(profile.providerId),
                routeKind: 'provider_bridge'
            };
        }
    }

    for (const providerLabel of SOURCE_OF_TRUTH_VALUES) {
        try {
            if (normalizeLegacyRoutePath(getCanonicalEntrypointFile(providerLabel)) === normalizedRoute) {
                return {
                    provider: providerLabel,
                    routeKind: 'provider_entrypoint'
                };
            }
        } catch {
            // Ignore unmaterialized entrypoints in compatibility inference.
        }
    }

    return {
        provider: null,
        routeKind: null
    };
}

function applyLegacyTaskModeIdentityBackfill(repoRoot: string, result: TaskModeEvidenceResult): void {
    const legacyRoutingMetadataMissing = (
        result.reviewer_capability_level == null
        && result.reviewer_expected_execution_mode == null
        && result.reviewer_fallback_allowed == null
        && result.reviewer_fallback_reason_required == null
    );
    const identityMetadataMissing = !result.canonical_source_of_truth || !result.execution_provider_source || !result.runtime_identity_status;
    if (
        !legacyRoutingMetadataMissing
        || !identityMetadataMissing
        || result.declares_runtime_identity_metadata
        || result.timeline_declares_runtime_identity_metadata
    ) {
        return;
    }

    const workspaceCanonicalSourceOfTruth = readLegacyCanonicalSourceOfTruth(repoRoot);
    const provider = normalizeLegacySourceOfTruthValue(result.provider);
    const routeIdentity = resolveLegacyRouteIdentity(result.routed_to);
    if (!workspaceCanonicalSourceOfTruth || !provider) {
        return;
    }
    let executionProvider = provider;
    if (routeIdentity.provider && routeIdentity.provider !== provider) {
        if (routeIdentity.routeKind === 'provider_bridge' && provider === workspaceCanonicalSourceOfTruth) {
            executionProvider = routeIdentity.provider;
        } else {
            result.runtime_identity_violations = [
                ...result.runtime_identity_violations,
                `Legacy task-mode routed_to '${result.routed_to}' identifies provider '${routeIdentity.provider}', ` +
                `but legacy task-mode provider is '${provider}'.`
            ];
            return;
        }
    }

    result.provider = executionProvider;
    result.canonical_source_of_truth = result.canonical_source_of_truth || workspaceCanonicalSourceOfTruth;
    result.execution_provider_source = result.execution_provider_source
        || routeIdentity.routeKind
        || (executionProvider === workspaceCanonicalSourceOfTruth ? 'provider_entrypoint' : 'explicit_provider');
    result.runtime_identity_status = result.runtime_identity_status || 'resolved';
    result.identity_backfilled_from_legacy = true;
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
    const dirtyWorkspaceBaseline = normalizeDirtyWorkspaceBaseline(options.dirtyWorkspaceBaseline || null);
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
        canonical_source_of_truth: String(options.canonicalSourceOfTruth || '').trim() || null,
        execution_provider_source: String(options.executionProviderSource || '').trim() || null,
        reviewer_capability_level: String(options.reviewerCapabilityLevel || '').trim() || null,
        reviewer_expected_execution_mode: String(options.reviewerExpectedExecutionMode || '').trim() || null,
        reviewer_fallback_allowed: typeof options.reviewerFallbackAllowed === 'boolean' ? options.reviewerFallbackAllowed : null,
        reviewer_fallback_reason_required: typeof options.reviewerFallbackReasonRequired === 'boolean'
            ? options.reviewerFallbackReasonRequired
            : null,
        runtime_identity_status: String(options.runtimeIdentityStatus || '').trim() || null,
        runtime_identity_violations: Array.isArray(options.runtimeIdentityViolations)
            ? options.runtimeIdentityViolations.map((entry) => String(entry || '').trim()).filter(Boolean)
            : [],
        routed_to: String(options.routedTo || '').trim() || null,
        actor,
        plan,
        active_profile: String(options.activeProfile || '').trim() || null,
        profile_source: options.profileSource || null,
        dirty_workspace_baseline: dirtyWorkspaceBaseline
    };
}

export function getTaskModeEvidence(repoRoot: string, taskId: string | null, artifactPath = ''): TaskModeEvidenceResult {
    const result: TaskModeEvidenceResult = {
        task_id: taskId,
        evidence_path: null,
        timeline_artifact_path: null,
        timeline_declares_runtime_identity_metadata: false,
        evidence_hash: null,
        declares_runtime_identity_metadata: false,
        identity_backfilled_from_legacy: false,
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
        canonical_source_of_truth: null,
        execution_provider_source: null,
        reviewer_capability_level: null,
        reviewer_expected_execution_mode: null,
        reviewer_fallback_allowed: null,
        reviewer_fallback_reason_required: null,
        runtime_identity_status: null,
        runtime_identity_violations: [],
        routed_to: null,
        plan: null,
        active_profile: null,
        profile_source: null,
        dirty_workspace_baseline: null
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
    result.declares_runtime_identity_metadata = [
        'canonical_source_of_truth',
        'execution_provider_source',
        'reviewer_capability_level',
        'reviewer_expected_execution_mode',
        'reviewer_fallback_allowed',
        'reviewer_fallback_reason_required',
        'runtime_identity_status',
        'runtime_identity_violations'
    ].some((key) => Object.prototype.hasOwnProperty.call(artifactObject, key));
    result.evidence_status = String(artifactObject.status || '').trim().toUpperCase();
    result.evidence_outcome = String(artifactObject.outcome || '').trim().toUpperCase();
    result.evidence_task_id = String(artifactObject.task_id || '').trim() || null;
    result.evidence_source = String(artifactObject.event_source || '').trim() || null;
    result.entry_mode = String(artifactObject.entry_mode || '').trim() || null;
    result.task_summary = String(artifactObject.task_summary || '').trim() || null;
    result.orchestrator_work = typeof artifactObject.orchestrator_work === 'boolean' ? artifactObject.orchestrator_work : null;
    result.provider = String(artifactObject.provider || '').trim() || null;
    result.canonical_source_of_truth = String(artifactObject.canonical_source_of_truth || '').trim() || null;
    result.execution_provider_source = String(artifactObject.execution_provider_source || '').trim() || null;
    result.reviewer_capability_level = String(artifactObject.reviewer_capability_level || '').trim() || null;
    result.reviewer_expected_execution_mode = String(artifactObject.reviewer_expected_execution_mode || '').trim() || null;
    result.reviewer_fallback_allowed = typeof artifactObject.reviewer_fallback_allowed === 'boolean'
        ? artifactObject.reviewer_fallback_allowed
        : null;
    result.reviewer_fallback_reason_required = typeof artifactObject.reviewer_fallback_reason_required === 'boolean'
        ? artifactObject.reviewer_fallback_reason_required
        : null;
    result.runtime_identity_status = String(artifactObject.runtime_identity_status || '').trim() || null;
    result.runtime_identity_violations = Array.isArray(artifactObject.runtime_identity_violations)
        ? artifactObject.runtime_identity_violations.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    result.routed_to = String(artifactObject.routed_to || '').trim() || null;
    const timelineMetadata = getLatestTaskModeTimelineMetadata(repoRoot, resolvedTaskId);
    result.timeline_artifact_path = timelineMetadata.artifact_path;
    result.timeline_declares_runtime_identity_metadata = timelineMetadata.declares_runtime_identity_metadata;
    applyLegacyTaskModeIdentityBackfill(repoRoot, result);

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
    result.dirty_workspace_baseline = normalizeDirtyWorkspaceBaseline(artifactObject.dirty_workspace_baseline);

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
    if (!result.canonical_source_of_truth) {
        result.evidence_status = 'EVIDENCE_CANONICAL_SOURCE_OF_TRUTH_INVALID';
        return result;
    }
    if (
        !result.execution_provider_source
        || !TASK_MODE_ENTRY_EXECUTION_PROVIDER_SOURCES.includes(
            result.execution_provider_source as (typeof TASK_MODE_ENTRY_EXECUTION_PROVIDER_SOURCES)[number]
        )
    ) {
        result.evidence_status = 'EVIDENCE_EXECUTION_PROVIDER_SOURCE_INVALID';
        return result;
    }
    if (
        !result.runtime_identity_status
        || !TASK_MODE_RUNTIME_IDENTITY_STATUSES.includes(
            result.runtime_identity_status as (typeof TASK_MODE_RUNTIME_IDENTITY_STATUSES)[number]
        )
    ) {
        result.evidence_status = 'EVIDENCE_RUNTIME_IDENTITY_STATUS_INVALID';
        return result;
    }
    if (result.runtime_identity_status !== 'resolved') {
        result.evidence_status = 'EVIDENCE_RUNTIME_IDENTITY_NOT_RESOLVED';
        return result;
    }
    if (result.runtime_identity_violations.length > 0) {
        result.evidence_status = 'EVIDENCE_RUNTIME_IDENTITY_VIOLATIONS_PRESENT';
        return result;
    }
    const routeIdentity = resolveLegacyRouteIdentity(result.routed_to);
    if (routeIdentity.provider && result.provider && routeIdentity.provider !== result.provider) {
        result.evidence_status = 'EVIDENCE_PROVIDER_ROUTE_MISMATCH';
        return result;
    }
    if (
        routeIdentity.routeKind
        && result.execution_provider_source
        && routeIdentity.routeKind !== result.execution_provider_source
    ) {
        result.evidence_status = 'EVIDENCE_EXECUTION_PROVIDER_SOURCE_ROUTE_MISMATCH';
        return result;
    }
    if (
        result.timeline_artifact_path
        && result.evidence_path
        && result.timeline_artifact_path.toLowerCase() !== result.evidence_path.toLowerCase()
    ) {
        result.evidence_status = 'EVIDENCE_ARTIFACT_PATH_MISMATCH';
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
        case 'EVIDENCE_CANONICAL_SOURCE_OF_TRUTH_INVALID':
            return ['Task-mode entry evidence is missing canonical_source_of_truth. Re-run enter-task-mode.'];
        case 'EVIDENCE_EXECUTION_PROVIDER_SOURCE_INVALID':
            return [
                `Task-mode entry evidence must record an explicit execution_provider_source (` +
                `${TASK_MODE_ENTRY_EXECUTION_PROVIDER_SOURCES.join(', ')}), got '${result.execution_provider_source || 'missing'}'.`
            ];
        case 'EVIDENCE_RUNTIME_IDENTITY_STATUS_INVALID':
            return [
                `Task-mode entry evidence has invalid runtime_identity_status '${result.runtime_identity_status || 'missing'}'. ` +
                `Allowed values: ${TASK_MODE_RUNTIME_IDENTITY_STATUSES.join(', ')}.`
            ];
        case 'EVIDENCE_RUNTIME_IDENTITY_NOT_RESOLVED':
            return [
                `Task-mode entry evidence must record runtime_identity_status='resolved', got '${result.runtime_identity_status}'. ` +
                'Re-run enter-task-mode with explicit runtime identity; legacy fallback and contradictory runtime identity are invalid.'
            ];
        case 'EVIDENCE_RUNTIME_IDENTITY_VIOLATIONS_PRESENT':
            return [
                `Task-mode entry evidence recorded runtime identity violations: ${result.runtime_identity_violations.join(' ')}`
            ];
        case 'EVIDENCE_PROVIDER_ROUTE_MISMATCH':
            return [
                `Task-mode entry evidence records provider '${result.provider || 'missing'}', ` +
                `but routed_to '${result.routed_to || 'missing'}' identifies a different provider.`
            ];
        case 'EVIDENCE_EXECUTION_PROVIDER_SOURCE_ROUTE_MISMATCH':
            return [
                `Task-mode entry evidence records execution_provider_source='${result.execution_provider_source || 'missing'}', ` +
                `but routed_to '${result.routed_to || 'missing'}' resolves to a different runtime source.`
            ];
        case 'EVIDENCE_ARTIFACT_PATH_MISMATCH':
            return [
                `Task-mode entry evidence artifact path mismatch. Timeline recorded '${result.timeline_artifact_path}', ` +
                `but current evidence path is '${evidencePath}'. Re-run downstream gates with the task-mode artifact path recorded by TASK_MODE_ENTERED.`
            ];
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
