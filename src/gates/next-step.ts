import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    getReviewExecutionDependencies,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode
} from '../core/review-execution-policy';
import { assertValidTaskId } from '../gate-runtime/task-events';
import {
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
    REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION
} from '../gate-runtime/reviewer-session-contract';
import {
    extractReviewVerdictToken,
    normalizeReviewReceiptReviewerProvenance
} from '../gate-runtime/review-context';
import {
    buildTaskAuditSummary,
    type TaskAuditSummaryResult
} from './task-audit-summary';
import {
    type GateOutcome,
    resolveEventsRoot,
    resolveReviewsRoot,
    safeReadJson
} from './task-audit-summary-collectors';
import {
    loadFullSuiteValidationConfig,
    resolveWorkflowConfigPath
} from './full-suite-validation';
import {
    buildReviewTrustSummary,
    type ReviewTrustSummary
} from './review-trust-summary';
import {
    fileSha256,
    normalizePath,
    resolvePathInsideRepo
} from './helpers';
import {
    resolveBundleNameForTarget
} from '../core/constants';
import {
    REVIEW_CONTRACTS
} from './required-reviews-check';
import {
    getWorkspaceSnapshotCached
} from './workspace-snapshot-cache';
import {
    selectRulePackFiles
} from './build-review-context';
import {
    getClassificationConfig,
    isDocumentationLikePath,
    isRuntimeCodeLikePath
} from './classify-change';
import {
    getPostPreflightSequenceEvidence,
    getRulePackEvidence,
    getRulePackEvidenceViolations
} from './rule-pack';
import {
    collectOrderedTimelineEvents,
    type TimelineEventEntry
} from './completion-evidence';
import {
    buildCoherentCycleRestartCommand
} from './completion-reporting';
import {
    normalizeProviderId
} from '../core/provider-registry';

const REVIEW_PREPARATION_ORDER = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency',
    'test'
]);

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));
const REVIEW_VERDICT_FAIL_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(
    REVIEW_CONTRACTS.map(([reviewType, passToken]) => [reviewType, passToken.replace(/\bPASSED\b/g, 'FAILED')])
));

export type NextStepStatus = 'BLOCKED' | 'READY' | 'DONE';

export interface NextStepCommand {
    label: string;
    command: string;
}

export interface NextStepArtifactState {
    key: string;
    path: string;
    exists: boolean;
}

export interface NextStepFullSuiteSummary {
    enabled: boolean;
    command: string;
    config_path: string;
    config_source: 'effective_workflow_config';
    note: string;
}

export interface NextStepReviewSummary {
    required_reviews: string[];
    review_execution_policy_mode: EffectiveReviewExecutionPolicyMode;
    review_execution_policy_source: 'preflight' | 'workflow_config_fallback';
    next_review_type: string | null;
    blocked_review_dependencies: string[];
    trust: ReviewTrustSummary | null;
    trust_note: string | null;
}

export interface NextStepResult {
    schema_version: 1;
    task_id: string;
    generated_utc: string;
    navigator_command: string;
    status: NextStepStatus;
    next_gate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missing_artifacts: NextStepArtifactState[];
    present_artifacts: NextStepArtifactState[];
    full_suite_validation: NextStepFullSuiteSummary;
    review: NextStepReviewSummary;
    audit_status: TaskAuditSummaryResult['status'];
}

interface TaskQueueEntry {
    taskId: string;
    title: string | null;
    profile: string | null;
}

interface NextStepOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
}

interface ArtifactSpec {
    key: string;
    path: string;
}

interface ReviewArtifactState {
    reviewType: string;
    contextPath: string;
    artifactPath: string;
    receiptPath: string;
    contextExists: boolean;
    contextCurrent: boolean;
    artifactExists: boolean;
    receiptExists: boolean;
    passToken: string;
    failToken: string;
    verdictToken: string | null;
    failed: boolean;
    ready: boolean;
    violations: string[];
    reviewerIdentity: string | null;
    contextReviewerIdentity: string | null;
    reviewerProvenance: {
        attestation_type: string;
        controller_event_type: string;
        task_sequence: number | null;
        prev_event_sha256: string | null;
        event_sha256: string | null;
        task_id?: string;
        review_type?: string;
        reviewer_execution_mode?: string;
        reviewer_identity?: string;
        review_context_sha256?: string;
        routing_event_sha256?: string;
    } | null;
}

interface CompileReadiness {
    ready: boolean;
    reason: string;
}

interface PreflightWorkspaceReadiness {
    ready: boolean;
    reason: string;
}

interface PreflightCycleReadiness {
    ready: boolean;
    reason: string;
}

interface RulePackReadiness {
    ready: boolean;
    reason: string;
}

interface StartupCycleReadiness {
    ready: boolean;
    nextGate: 'load-rule-pack' | 'handshake-diagnostics' | 'shell-smoke-preflight' | null;
    title: string;
    reason: string;
}

interface CoherentCycleReadiness {
    ready: boolean;
    reason: string;
    command: string | null;
}

const COHERENT_CYCLE_BOUNDARY_EVENTS = new Set([
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_FAILED',
    'COMPLETION_GATE_PASSED'
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function toRepoDisplayPath(repoRoot: string, filePath: string): string {
    const relative = path.relative(path.resolve(repoRoot), path.resolve(filePath));
    return normalizePath(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : filePath);
}

function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? 'node bin/garda.js'
        : `node ${resolveBundleNameForTarget(repoRoot)}/bin/garda.js`;
}

function buildBundleRelativePath(repoRoot: string, relativePath: string): string {
    return normalizePath(path.join(resolveBundleNameForTarget(repoRoot), relativePath));
}

function artifactState(repoRoot: string, specs: ArtifactSpec[]): {
    present: NextStepArtifactState[];
    missing: NextStepArtifactState[];
} {
    const states = specs.map((spec) => ({
        key: spec.key,
        path: toRepoDisplayPath(repoRoot, spec.path),
        exists: fileExists(spec.path)
    }));
    return {
        present: states.filter((state) => state.exists),
        missing: states.filter((state) => !state.exists)
    };
}

function getGateStatus(summary: TaskAuditSummaryResult, gateName: string): GateOutcome['status'] | null {
    return summary.gates.find((gate) => gate.gate === gateName)?.status || null;
}

function isGatePassed(summary: TaskAuditSummaryResult, gateName: string): boolean {
    return getGateStatus(summary, gateName) === 'PASS';
}

function getRequiredReviewTypes(requiredReviews: Record<string, boolean>): string[] {
    return REVIEW_PREPARATION_ORDER.filter((reviewType) => requiredReviews[reviewType] === true);
}

function resolveReviewPolicy(preflight: Record<string, unknown> | null): {
    mode: EffectiveReviewExecutionPolicyMode;
    source: 'preflight' | 'workflow_config_fallback';
} {
    if (preflight && isPlainRecord(preflight.review_execution_policy)) {
        return {
            mode: resolveReviewExecutionPolicyModeFromPreflight(preflight),
            source: 'preflight'
        };
    }
    return {
        mode: resolveReviewExecutionPolicyModeFromPreflight(null),
        source: 'workflow_config_fallback'
    };
}

function readReviewArtifactState(
    reviewsRoot: string,
    taskId: string,
    reviewType: string,
    preflightPath: string,
    preflightSha256: string | null
): ReviewArtifactState {
    const contextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const passToken = REVIEW_VERDICT_PASS_TOKENS[reviewType] || '';
    const failToken = REVIEW_VERDICT_FAIL_TOKENS[reviewType] || '';
    const violations: string[] = [];
    const contextExists = fileExists(contextPath);
    let contextCurrent = false;
    const artifactExists = fileExists(artifactPath);
    const receiptExists = fileExists(receiptPath);
    let context: Record<string, unknown> | null = null;
    let receipt: Record<string, unknown> | null = null;
    let reviewerIdentity: string | null = null;
    let contextReviewerIdentity: string | null = null;
    let reviewerProvenance: ReviewArtifactState['reviewerProvenance'] = null;
    let verdictToken: string | null = null;
    let failed = false;

    if (!contextExists) {
        violations.push('review context artifact is missing');
    } else {
        context = safeReadJson(contextPath);
        if (!context) {
            violations.push('review context artifact is invalid JSON');
        } else {
            const reviewerRouting = isPlainRecord(context.reviewer_routing)
                ? context.reviewer_routing
                : null;
            const contextReviewerSessionId = typeof reviewerRouting?.reviewer_session_id === 'string'
                ? reviewerRouting.reviewer_session_id.trim()
                : '';
            contextReviewerIdentity = contextReviewerSessionId || null;
            const contextPreflightPath = typeof context.preflight_path === 'string'
                ? normalizePath(context.preflight_path)
                : '';
            const contextPreflightHash = typeof context.preflight_sha256 === 'string'
                ? context.preflight_sha256.trim().toLowerCase()
                : '';
            const expectedPreflightPath = normalizePath(preflightPath);
            const expectedPreflightHash = String(preflightSha256 || '').trim().toLowerCase();
            if (
                contextPreflightPath
                && contextPreflightHash
                && contextPreflightPath.toLowerCase() === expectedPreflightPath.toLowerCase()
                && contextPreflightHash === expectedPreflightHash
            ) {
                contextCurrent = true;
            } else {
                violations.push('review context preflight binding is stale or missing');
            }
        }
    }

    if (!artifactExists) {
        violations.push('review artifact is missing');
    } else {
        const content = fs.readFileSync(artifactPath, 'utf8');
        const parsedVerdictToken = extractReviewVerdictToken(content, passToken || null, failToken || null);
        if (failToken && parsedVerdictToken === failToken) {
            verdictToken = failToken;
            failed = true;
            violations.push(
                `review artifact contains fail token '${failToken}'; fix implementation and rerun compile plus '${reviewType}' review before launching dependent reviews`
            );
        } else if (passToken && parsedVerdictToken === passToken) {
            verdictToken = passToken;
        } else {
            violations.push(`review artifact does not contain pass token '${passToken || '<unknown>'}'`);
        }
    }

    if (!receiptExists) {
        violations.push('review receipt is missing');
    } else {
        receipt = safeReadJson(receiptPath);
        if (!receipt) {
            violations.push('review receipt is invalid JSON');
        }
    }

    if (context && receipt && artifactExists) {
        const artifactHash = fileSha256(artifactPath);
        const contextHash = fileSha256(contextPath);
        const receiptArtifactHash = typeof receipt.review_artifact_sha256 === 'string'
            ? receipt.review_artifact_sha256.trim().toLowerCase()
            : '';
        const receiptContextHash = typeof receipt.review_context_sha256 === 'string'
            ? receipt.review_context_sha256.trim().toLowerCase()
            : '';
        const reviewerRouting = isPlainRecord(context.reviewer_routing)
            ? context.reviewer_routing
            : null;
        const contextExecutionMode = typeof reviewerRouting?.actual_execution_mode === 'string'
            ? reviewerRouting.actual_execution_mode.trim()
            : '';
        const contextReviewerSessionId = typeof reviewerRouting?.reviewer_session_id === 'string'
            ? reviewerRouting.reviewer_session_id.trim()
            : '';
        const receiptExecutionMode = typeof receipt.reviewer_execution_mode === 'string'
            ? receipt.reviewer_execution_mode.trim()
            : '';
        const receiptReviewerIdentity = typeof receipt.reviewer_identity === 'string'
            ? receipt.reviewer_identity.trim()
            : '';
        reviewerIdentity = receiptReviewerIdentity || null;
        const normalizedProvenance = receipt.reviewer_provenance == null
            ? null
            : normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
        reviewerProvenance = normalizedProvenance
            ? {
                attestation_type: normalizedProvenance.attestation_type,
                controller_event_type: normalizedProvenance.controller_event_type,
                task_sequence: normalizedProvenance.task_sequence,
                prev_event_sha256: normalizedProvenance.prev_event_sha256 == null
                    ? null
                    : String(normalizedProvenance.prev_event_sha256 || '').trim().toLowerCase() || null,
                event_sha256: String(normalizedProvenance.event_sha256 || '').trim().toLowerCase() || null,
                task_id: 'task_id' in normalizedProvenance ? normalizedProvenance.task_id : undefined,
                review_type: 'review_type' in normalizedProvenance ? normalizedProvenance.review_type : undefined,
                reviewer_execution_mode: 'reviewer_execution_mode' in normalizedProvenance ? normalizedProvenance.reviewer_execution_mode : undefined,
                reviewer_identity: 'reviewer_identity' in normalizedProvenance ? normalizedProvenance.reviewer_identity : undefined,
                review_context_sha256: 'review_context_sha256' in normalizedProvenance ? normalizedProvenance.review_context_sha256 : undefined,
                routing_event_sha256: 'routing_event_sha256' in normalizedProvenance ? normalizedProvenance.routing_event_sha256 : undefined
            }
            : null;
        if (receipt.task_id !== taskId) {
            violations.push(`review receipt belongs to task '${String(receipt.task_id || '')}'`);
        }
        if (receipt.review_type !== reviewType) {
            violations.push(`review receipt has review_type '${String(receipt.review_type || '')}'`);
        }
        if (!artifactHash || receiptArtifactHash !== artifactHash) {
            violations.push('review artifact hash does not match the receipt');
        }
        if (!contextHash || receiptContextHash !== contextHash) {
            violations.push('review context hash does not match the receipt');
        }
        if (receiptExecutionMode !== 'delegated_subagent') {
            violations.push("review receipt does not use reviewer_execution_mode 'delegated_subagent'");
        }
        if (String(receipt.trust_level || '').trim() !== 'INDEPENDENT_AUDITED') {
            violations.push("review receipt trust_level must be 'INDEPENDENT_AUDITED'");
        }
        if (!receiptReviewerIdentity.startsWith('agent:')) {
            violations.push("review receipt reviewer_identity must use 'agent:' scope");
        }
        if (contextExecutionMode !== 'delegated_subagent') {
            violations.push("review context is missing delegated_subagent routing metadata");
        }
        if (contextReviewerSessionId !== receiptReviewerIdentity) {
            violations.push('review context reviewer identity does not match the receipt');
        }
        if (receipt.reviewer_provenance == null) {
            violations.push('review receipt is missing reviewer_provenance');
        } else if (!normalizedProvenance) {
            violations.push('review receipt reviewer_provenance is invalid');
        } else if (
            !reviewerProvenance?.task_sequence
            || !reviewerProvenance.event_sha256
            || !/^[0-9a-f]{64}$/.test(reviewerProvenance.event_sha256)
        ) {
            violations.push('review receipt reviewer_provenance is incomplete');
        } else if (reviewerProvenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED') {
            violations.push('review receipt reviewer_provenance must reference REVIEWER_INVOCATION_ATTESTED telemetry');
        }
    }

    return {
        reviewType,
        contextPath,
        artifactPath,
        receiptPath,
        contextExists,
        contextCurrent,
        artifactExists,
        receiptExists,
        passToken,
        failToken,
        verdictToken,
        failed,
        ready: violations.length === 0,
        violations,
        reviewerIdentity,
        contextReviewerIdentity,
        reviewerProvenance
    };
}

function getLatestTaskSequenceForEventTypes(eventsRoot: string, taskId: string, eventTypes: string[]): number | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return null;
    }
    const wanted = new Set(eventTypes);
    let latestSequence: number | null = null;
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (!wanted.has(String(event.event_type || '').trim())) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const sequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (Number.isInteger(sequence) && sequence > 0) {
                latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return latestSequence;
}

function timelineHasDelegatedReviewInvocationAttestation(eventsRoot: string, taskId: string, state: ReviewArtifactState): boolean {
    if (!state.reviewerIdentity || !state.reviewerProvenance?.task_sequence || !state.reviewerProvenance.event_sha256) {
        return false;
    }
    if (
        state.reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation'
        || state.reviewerProvenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED'
    ) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null || state.reviewerProvenance.task_sequence <= latestCompileSequence) {
        return false;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (String(details.task_id || '').trim() !== taskId) {
                continue;
            }
            if (String(details.review_type || '').trim() !== state.reviewType) {
                continue;
            }
            if (String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent') {
                continue;
            }
            const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
            if (eventReviewerIdentity !== state.reviewerIdentity) {
                continue;
            }
            const reviewContextSha256 = String(details.review_context_sha256 || '').trim().toLowerCase();
            const routingEventSha256 = String(details.routing_event_sha256 || '').trim().toLowerCase();
            if (
                reviewContextSha256 !== String(state.reviewerProvenance.review_context_sha256 || '').trim().toLowerCase()
                || routingEventSha256 !== String(state.reviewerProvenance.routing_event_sha256 || '').trim().toLowerCase()
            ) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256 = integrity?.prev_event_sha256 == null
                ? null
                : String(integrity.prev_event_sha256 || '').trim().toLowerCase() || null;
            if (
                taskSequence !== state.reviewerProvenance.task_sequence
                || eventSha256 !== state.reviewerProvenance.event_sha256
                || prevEventSha256 !== state.reviewerProvenance.prev_event_sha256
            ) {
                continue;
            }
            return true;
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function timelineHasDelegatedReviewInvocationForCurrentContext(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    const reviewerIdentity = state.contextReviewerIdentity;
    if (!reviewerIdentity?.startsWith('agent:') || !state.contextExists || !state.contextCurrent) {
        return false;
    }
    const reviewContextSha256 = fileSha256(state.contextPath);
    if (!reviewContextSha256) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return false;
    }
    const events = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
            try {
                return [JSON.parse(line) as Record<string, unknown>];
            } catch {
                return [];
            }
        });
    let routingEventSha256: string | null = null;
    let routingSequence: number | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
            continue;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const taskSequence = typeof integrity?.task_sequence === 'number'
            ? integrity.task_sequence
            : Number(integrity?.task_sequence);
        if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        if (
            String(details.review_type || '').trim() !== state.reviewType
            || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
            || String(details.reviewer_session_id || '').trim() !== reviewerIdentity
        ) {
            continue;
        }
        routingEventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
        routingSequence = taskSequence;
        break;
    }
    if (!routingEventSha256 || !routingSequence) {
        return false;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const taskSequence = typeof integrity?.task_sequence === 'number'
            ? integrity.task_sequence
            : Number(integrity?.task_sequence);
        if (!Number.isInteger(taskSequence) || taskSequence <= routingSequence) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
        if (
            String(details.task_id || '').trim() !== taskId
            || String(details.review_type || '').trim() !== state.reviewType
            || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
            || eventReviewerIdentity !== reviewerIdentity
            || String(details.review_context_sha256 || '').trim().toLowerCase() !== reviewContextSha256
            || String(details.routing_event_sha256 || '').trim().toLowerCase() !== routingEventSha256
        ) {
            continue;
        }
        return true;
    }
    return false;
}

function timelineHasDelegatedReviewRoutingAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string
): boolean {
    if (!reviewerIdentity.startsWith('agent:')) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return false;
    }
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (
                String(details.review_type || '').trim() === reviewType
                && String(details.reviewer_execution_mode || '').trim() === 'delegated_subagent'
                && String(details.reviewer_session_id || '').trim() === reviewerIdentity
            ) {
                return true;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function timelineHasReviewContextPreparedAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    contextPath: string
): boolean {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return false;
    }
    const expectedContextPath = normalizePath(contextPath).toLowerCase();
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEW_PHASE_STARTED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            const eventReviewType = String(details.review_type || details.reviewType || '').trim();
            const outputPath = normalizePath(details.output_path || details.outputPath || '').toLowerCase();
            if (eventReviewType === reviewType && outputPath === expectedContextPath) {
                return true;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function readReviewTrust(
    reviewsRoot: string,
    taskId: string,
    requiredReviewTypes: string[],
    scopeCategory: string | null
): ReviewTrustSummary | null {
    const entries = requiredReviewTypes.flatMap((reviewType) => {
        const receipt = safeReadJson(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`));
        if (!receipt) {
            return [];
        }
        return [{
            review_type: reviewType,
            trust_level: typeof receipt.trust_level === 'string' ? receipt.trust_level : null,
            reviewer_execution_mode: typeof receipt.reviewer_execution_mode === 'string'
                ? receipt.reviewer_execution_mode
                : null,
            reviewer_identity: typeof receipt.reviewer_identity === 'string'
                ? receipt.reviewer_identity
                : null,
            reviewer_fallback_reason: typeof receipt.reviewer_fallback_reason === 'string'
                ? receipt.reviewer_fallback_reason
                : null,
            reviewer_provenance: receipt.reviewer_provenance ?? null
        }];
    });
    return buildReviewTrustSummary(entries, scopeCategory, requiredReviewTypes.length);
}

function getNextReviewType(
    requiredReviewTypes: string[],
    policyMode: EffectiveReviewExecutionPolicyMode,
    requiredReviews: Record<string, boolean>,
    reviewStates: ReviewArtifactState[],
    eventsRoot: string,
    taskId: string
): { reviewType: string | null; blockedDependencies: string[] } {
    const passedReviews = new Set(
        reviewStates
            .filter((state) => state.ready && timelineHasDelegatedReviewInvocationAttestation(eventsRoot, taskId, state))
            .map((state) => state.reviewType)
    );
    for (const reviewType of requiredReviewTypes) {
        if (passedReviews.has(reviewType)) {
            continue;
        }
        const blockedDependencies = getReviewExecutionDependencies(reviewType, requiredReviews, policyMode)
            .filter((dependency) => !passedReviews.has(dependency));
        if (blockedDependencies.length > 0) {
            return {
                reviewType,
                blockedDependencies
            };
        }
        return {
            reviewType,
            blockedDependencies: []
        };
    }
    return {
        reviewType: null,
        blockedDependencies: []
    };
}

function getDownstreamReviewTypesFor(
    failedReviewType: string,
    requiredReviewTypes: string[],
    requiredReviews: Record<string, boolean>,
    policyMode: EffectiveReviewExecutionPolicyMode
): string[] {
    return requiredReviewTypes.filter((reviewType) => (
        reviewType !== failedReviewType
        && getReviewExecutionDependencies(reviewType, requiredReviews, policyMode).includes(failedReviewType)
    ));
}

function describeBlockedReviewDependencies(
    dependencies: readonly string[],
    reviewStates: readonly ReviewArtifactState[]
): string {
    const stateByType = new Map(reviewStates.map((state) => [state.reviewType, state]));
    return dependencies
        .map((dependency) => {
            const dependencyState = stateByType.get(dependency);
            if (dependencyState?.failed) {
                return `${dependency} failed with '${dependencyState.verdictToken || dependencyState.failToken || 'FAILED'}'`;
            }
            if (dependencyState?.artifactExists && !dependencyState.ready) {
                return `${dependency} is not PASS-ready (${dependencyState.violations.join('; ')})`;
            }
            return `${dependency} has no current PASS artifact and receipt`;
        })
        .join('; ');
}

function readCompileReadiness(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    preflightPath: string
): CompileReadiness {
    const compilePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
    if (!fileExists(compilePath)) {
        return {
            ready: false,
            reason: `Compile gate evidence missing: ${normalizePath(compilePath)}.`
        };
    }
    const evidence = safeReadJson(compilePath);
    if (!evidence) {
        return {
            ready: false,
            reason: 'Compile gate evidence is invalid JSON; rerun compile-gate.'
        };
    }
    const expectedPreflightHash = fileSha256(preflightPath);
    const evidenceStatus = String(evidence.status || '').trim().toUpperCase();
    const evidenceOutcome = String(evidence.outcome || '').trim().toUpperCase();
    if (evidence.task_id !== taskId) {
        return {
            ready: false,
            reason: `Compile gate evidence belongs to task '${String(evidence.task_id || '')}'.`
        };
    }
    if (String(evidence.event_source || '').trim() !== 'compile-gate') {
        return {
            ready: false,
            reason: 'Compile gate evidence source is invalid; rerun compile-gate.'
        };
    }
    if (evidenceStatus !== 'PASSED' || evidenceOutcome !== 'PASS') {
        return {
            ready: false,
            reason: `Compile gate did not pass. Evidence status='${evidenceStatus || 'UNKNOWN'}', outcome='${evidenceOutcome || 'UNKNOWN'}'.`
        };
    }
    const evidencePreflightHash = String(evidence.preflight_hash_sha256 || '').trim().toLowerCase();
    if (!expectedPreflightHash || evidencePreflightHash !== expectedPreflightHash) {
        return {
            ready: false,
            reason: 'Compile gate evidence preflight hash does not match the current preflight; rerun compile-gate.'
        };
    }
    const detectionSource = String(evidence.scope_detection_source || '').trim();
    const changedFiles = Array.isArray(evidence.scope_changed_files)
        ? evidence.scope_changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const scopeSha256 = String(evidence.scope_sha256 || '').trim();
    const changedFilesSha256 = String(evidence.scope_changed_files_sha256 || '').trim();
    const changedLinesTotal = Number.parseInt(String(evidence.scope_changed_lines_total || 0), 10) || 0;
    if (!detectionSource || !scopeSha256 || !changedFilesSha256) {
        return {
            ready: false,
            reason: 'Compile gate evidence is missing scope snapshot fields; rerun compile-gate.'
        };
    }
    const currentScope = getWorkspaceSnapshotCached(
        repoRoot,
        detectionSource,
        evidence.scope_include_untracked == null ? true : !!evidence.scope_include_untracked,
        changedFiles
    );
    if (
        currentScope.scope_sha256 !== scopeSha256
        || currentScope.changed_files_sha256 !== changedFilesSha256
        || currentScope.changed_lines_total !== changedLinesTotal
    ) {
        return {
            ready: false,
            reason: 'Workspace changed after compile gate; rerun compile-gate before review preparation.'
        };
    }
    return {
        ready: true,
        reason: 'Compile gate evidence is current.'
    };
}

function stringSha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readPreflightWorkspaceReadiness(
    repoRoot: string,
    preflight: Record<string, unknown>
): PreflightWorkspaceReadiness {
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const expectedChangedLinesTotal = typeof metrics.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : Number(metrics.changed_lines_total);
    if (!Number.isFinite(expectedChangedLinesTotal) || expectedChangedLinesTotal < 0) {
        return {
            ready: true,
            reason: 'Preflight workspace freshness cannot be checked because metrics.changed_lines_total is missing.'
        };
    }

    const detectionSource = String(preflight.detection_source || 'git_auto').trim() || 'git_auto';
    const changedFiles = Array.isArray(preflight.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    const expectedChangedFilesSha256 = stringSha256(changedFiles.join('\n'));
    const currentScope = getWorkspaceSnapshotCached(
        repoRoot,
        detectionSource,
        detectionSource.toLowerCase() === 'git_staged_only'
            ? false
            : (typeof preflight.include_untracked === 'boolean' ? preflight.include_untracked : true),
        changedFiles
    );
    const violations: string[] = [];
    if (currentScope.changed_files_sha256 !== expectedChangedFilesSha256) {
        violations.push('preflight changed_files differ from the current workspace snapshot');
    }
    if (currentScope.changed_lines_total !== expectedChangedLinesTotal) {
        violations.push(
            `preflight changed_lines_total=${expectedChangedLinesTotal} differs from current changed_lines_total=${currentScope.changed_lines_total}`
        );
    }

    if (violations.length === 0) {
        return {
            ready: true,
            reason: 'Preflight scope still matches the current workspace.'
        };
    }
    return {
        ready: false,
        reason: `Preflight scope is stale before compile (${violations.join('; ')}). Refresh classify-change for the current scope first.`
    };
}

function readPreflightCycleReadiness(
    eventsRoot: string,
    taskId: string
): PreflightCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.'
        };
    }

    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (!latestPreflight) {
        return {
            ready: true,
            reason: 'No PREFLIGHT_CLASSIFIED event exists yet.'
        };
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (latestTaskMode && latestPreflight.sequence < latestTaskMode.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest TASK_MODE_ENTERED event (preflight seq ${latestPreflight.sequence}, task-mode seq ${latestTaskMode.sequence}). Refresh classify-change for the current task-mode cycle.`
        };
    }

    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
    );
    if (latestShellSmoke && latestPreflight.sequence < latestShellSmoke.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest SHELL_SMOKE_PREFLIGHT_RECORDED event (preflight seq ${latestPreflight.sequence}, shell-smoke seq ${latestShellSmoke.sequence}). Refresh classify-change before compile/review/completion.`
        };
    }

    const latestCompletionFailure = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'COMPLETION_GATE_FAILED'
    );
    if (latestCompletionFailure && latestPreflight.sequence < latestCompletionFailure.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest COMPLETION_GATE_FAILED event (preflight seq ${latestPreflight.sequence}, completion failure seq ${latestCompletionFailure.sequence}). Refresh classify-change for the resumed cycle.`
        };
    }

    return {
        ready: true,
        reason: 'Preflight evidence is current for the latest startup cycle.'
    };
}

function readPostPreflightRulePackReadiness(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    rulePackPath: string
): RulePackReadiness {
    const evidence = getRulePackEvidence(repoRoot, taskId, 'POST_PREFLIGHT', {
        preflightPath,
        artifactPath: rulePackPath
    });
    const sequenceEvidence = getPostPreflightSequenceEvidence(repoRoot, taskId, preflightPath, {
        artifactPath: rulePackPath
    });
    const violations = [
        ...getRulePackEvidenceViolations(evidence),
        ...sequenceEvidence.violations
    ];
    if (violations.length === 0 && evidence.binding_equivalent_to_current_preflight && sequenceEvidence.binding_equivalent_to_current_preflight) {
        return {
            ready: true,
            reason: 'POST_PREFLIGHT rule-pack evidence is current for the latest preflight.'
        };
    }
    if (violations.length === 0) {
        violations.push('POST_PREFLIGHT rule-pack evidence is not bound to the latest preflight.');
    }
    return {
        ready: false,
        reason: violations.join(' ')
    };
}

function readStartupCycleReadiness(
    eventsRoot: string,
    taskId: string
): StartupCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            nextGate: null,
            title: 'Startup cycle ordering was not checked.',
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.'
        };
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (!latestTaskMode) {
        return {
            ready: true,
            nextGate: null,
            title: 'No task-mode cycle exists yet.',
            reason: 'No TASK_MODE_ENTERED event exists yet.'
        };
    }

    const isStartupRulePackEvent = (entry: TimelineEventEntry): boolean => {
        if (entry.event_type !== 'RULE_PACK_LOADED') {
            return false;
        }
        const stage = String(entry.details?.stage || '').trim().toUpperCase();
        return stage !== 'POST_PREFLIGHT';
    };
    const latestRulePack = findLatestTimelineEvent(
        events,
        (entry) => isStartupRulePackEvent(entry) && entry.sequence > latestTaskMode.sequence
    );
    if (!latestRulePack) {
        return {
            ready: false,
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files for the current task-mode cycle.',
            reason: `The latest TASK_MODE_ENTERED event is seq ${latestTaskMode.sequence}, but no RULE_PACK_LOADED event exists after it. Load TASK_ENTRY rules before handshake, preflight, compile, review, or completion.`
        };
    }

    const latestHandshake = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED' && entry.sequence > latestRulePack.sequence
    );
    if (!latestHandshake) {
        return {
            ready: false,
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics for the current task-mode cycle.',
            reason: `The latest TASK_MODE_ENTERED event is seq ${latestTaskMode.sequence}, and the latest startup rule-pack event is seq ${latestRulePack.sequence}, but no HANDSHAKE_DIAGNOSTICS_RECORDED event exists after them.`
        };
    }

    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED' && entry.sequence > latestHandshake.sequence
    );
    if (!latestShellSmoke) {
        return {
            ready: false,
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight for the current task-mode cycle.',
            reason: `The latest HANDSHAKE_DIAGNOSTICS_RECORDED event is seq ${latestHandshake.sequence}, but no SHELL_SMOKE_PREFLIGHT_RECORDED event exists after it.`
        };
    }

    return {
        ready: true,
        nextGate: null,
        title: 'Startup cycle is current.',
        reason: 'TASK_ENTRY rule-pack, handshake, and shell-smoke evidence are current for the latest task-mode cycle.'
    };
}

function findLatestTimelineEvent(
    events: TimelineEventEntry[],
    predicate: (entry: TimelineEventEntry) => boolean
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (predicate(entry)) {
            return entry;
        }
    }
    return null;
}

function getDefaultCommandsPath(repoRoot: string): string {
    return path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/40-commands.md'));
}

function getDefaultOutputFiltersPath(repoRoot: string): string {
    return path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'live/config/output-filters.json'));
}

function readCoherentCycleReadiness(
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    taskId: string,
    preflightPath: string
): CoherentCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.',
            command: null
        };
    }

    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (!latestPreflight) {
        return {
            ready: true,
            reason: 'No PREFLIGHT_CLASSIFIED event exists yet.',
            command: null
        };
    }

    const latestBoundary = findLatestTimelineEvent(
        events,
        (entry) => entry.sequence < latestPreflight.sequence && COHERENT_CYCLE_BOUNDARY_EVENTS.has(entry.event_type)
    );
    const lowerBoundExclusive = latestBoundary?.sequence ?? Number.NEGATIVE_INFINITY;
    const latestHandshake = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
            && entry.sequence > lowerBoundExclusive
            && entry.sequence < latestPreflight.sequence
        )
    );
    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
            && entry.sequence > lowerBoundExclusive
            && entry.sequence < latestPreflight.sequence
        )
    );

    const violations: string[] = [];
    if (!latestHandshake) {
        violations.push('HANDSHAKE_DIAGNOSTICS_RECORDED is missing before the latest PREFLIGHT_CLASSIFIED inside the latest execution cycle');
    }
    if (!latestShellSmoke) {
        violations.push('SHELL_SMOKE_PREFLIGHT_RECORDED is missing before the latest PREFLIGHT_CLASSIFIED inside the latest execution cycle');
    }
    if (latestHandshake && latestShellSmoke && latestShellSmoke.sequence < latestHandshake.sequence) {
        violations.push('SHELL_SMOKE_PREFLIGHT_RECORDED predates HANDSHAKE_DIAGNOSTICS_RECORDED inside the latest execution cycle');
    }

    if (violations.length === 0) {
        return {
            ready: true,
            reason: 'Latest preflight has current-cycle handshake and shell-smoke evidence.',
            command: null
        };
    }

    const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
    const commandsPath = typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
        ? compileEvidence.commands_path.trim()
        : getDefaultCommandsPath(repoRoot);
    const outputFiltersPath = typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
        ? compileEvidence.output_filters_path.trim()
        : getDefaultOutputFiltersPath(repoRoot);
    const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
    const cycleAnchor = latestBoundary
        ? ` after latest ${latestBoundary.event_type} (seq ${latestBoundary.sequence})`
        : '';

    return {
        ready: false,
        reason: `Latest PREFLIGHT_CLASSIFIED (seq ${latestPreflight.sequence}) is not in a coherent preflight cycle${cycleAnchor}: ${violations.join('; ')}. Run restart-coherent-cycle before compile/review/completion so completion-gate does not fail on stage sequence.`,
        command: buildCoherentCycleRestartCommand(
            repoRoot,
            taskId,
            normalizePath(preflightPath),
            taskModePath,
            commandsPath,
            outputFiltersPath
        )
    };
}

function buildCommand(label: string, command: string): NextStepCommand {
    return { label, command };
}

function buildNavigatorCommand(cliPrefix: string, taskId: string): string {
    return `${cliPrefix} next-step "${taskId}" --repo-root "."`;
}

function quoteCommandValue(value: string): string {
    const text = String(value);
    if (/["$`]/.test(text)) {
        if (process.platform === 'win32') {
            return `'${text.replace(/'/g, "''")}'`;
        }
        return `'${text.replace(/'/g, "'\\''")}'`;
    }
    return `"${text.replace(/\\/g, '\\\\')}"`;
}

function readTaskQueueEntry(repoRoot: string, taskId: string): TaskQueueEntry | null {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fileExists(taskPath)) {
        return null;
    }
    const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rowPattern = new RegExp(`^\\|\\s*${escapedTaskId}\\s*\\|`);
    for (const line of fs.readFileSync(taskPath, 'utf8').split('\n')) {
        if (!rowPattern.test(line)) {
            continue;
        }
        const cells = line
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim());
        if (cells.length < 8) {
            return {
                taskId,
                title: null,
                profile: null
            };
        }
        return {
            taskId,
            title: cells[4] || null,
            profile: cells[7] || null
        };
    }
    return null;
}

function resolveDefaultDepthFromTaskQueue(taskEntry: TaskQueueEntry | null): string {
    const profile = String(taskEntry?.profile || '').trim().toLowerCase();
    if (profile === 'fast' || profile === 'docs-only') {
        return '1';
    }
    return '2';
}

function resolveProviderFromEnvironment(): string | null {
    const explicitProvider = normalizeProviderId(process.env.GARDA_EXECUTION_PROVIDER);
    if (explicitProvider) {
        return explicitProvider;
    }
    if (process.env.CODEX_THREAD_ID || process.env.CODEX_HOME) {
        return 'Codex';
    }
    if (process.env.CLAUDE_CODE_SSE_PORT) {
        return 'Claude';
    }
    if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT) {
        return 'Cursor';
    }
    return null;
}

function quoteProviderForCommand(provider: string | null): string {
    if (provider) {
        return quoteCommandValue(provider);
    }
    return process.platform === 'win32'
        ? '"$env:GARDA_EXECUTION_PROVIDER"'
        : '"$GARDA_EXECUTION_PROVIDER"';
}

function buildEnterTaskModeCommand(
    cliPrefix: string,
    taskId: string,
    taskEntry: TaskQueueEntry | null,
    provider: string | null
): string {
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        '--entry-mode "EXPLICIT_TASK_EXECUTION"',
        `--requested-depth ${quoteCommandValue(resolveDefaultDepthFromTaskQueue(taskEntry))}`,
        `--task-summary ${quoteCommandValue(taskEntry?.title || taskId)}`,
        '--start-banner "Garda captures my mind"'
    ];
    parts.push(`--provider ${quoteProviderForCommand(provider)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function requiresSensitiveScopeDocAcknowledgement(preflight: Record<string, unknown> | null): boolean {
    const triggers = getPreflightTriggers(preflight);
    return ['api', 'security', 'infra', 'dependency', 'db'].some((trigger) => triggers[trigger] === true);
}

function getPreflightChangedFiles(preflight: Record<string, unknown> | null): string[] {
    return Array.isArray(preflight?.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
}

function isChangelogPath(filePath: string): boolean {
    return /(^|\/)CHANGELOG/i.test(normalizePath(filePath));
}

function getDocImpactChangedFiles(
    preflight: Record<string, unknown> | null,
    repoRoot: string
): string[] {
    const classificationConfig = getClassificationConfig(repoRoot);
    return getPreflightChangedFiles(preflight).filter((filePath) => (
        isDocumentationLikePath(filePath)
        && !isRuntimeCodeLikePath(filePath, classificationConfig.code_like_regexes, classificationConfig.runtime_roots)
    ));
}

function buildDocImpactCommand(
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    preflight: Record<string, unknown> | null,
    repoRoot: string
): string {
    const docsUpdated = getDocImpactChangedFiles(preflight, repoRoot);
    const changelogUpdated = docsUpdated.some((filePath) => isChangelogPath(filePath));
    const parts = [
        `${cliPrefix} gate doc-impact-gate`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--preflight-path ${quoteCommandValue(preflightCommandPath)}`
    ];
    if (docsUpdated.length > 0) {
        parts.push('--decision "DOCS_UPDATED"');
        parts.push('--behavior-changed false');
        for (const docPath of docsUpdated) {
            parts.push(`--docs-updated ${quoteCommandValue(docPath)}`);
        }
        parts.push(`--changelog-updated ${changelogUpdated ? 'true' : 'false'}`);
    } else {
        parts.push('--decision "NO_DOC_UPDATES"');
        parts.push('--behavior-changed false');
        parts.push('--changelog-updated false');
    }
    if (requiresSensitiveScopeDocAcknowledgement(preflight)) {
        parts.push('--sensitive-scope-reviewed true');
    }
    parts.push(docsUpdated.length > 0
        ? '--rationale "Documentation or changelog files were changed in the current preflight; next-step records them without requiring a fresh code/test review when non-doc scope is unchanged."'
        : '--rationale "No user-facing documentation impact detected by next-step; adjust this command before running if docs or behavior changed."');
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function getLatestTimelineSequence(eventsRoot: string, taskId: string, eventType: string): number | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const errors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, errors);
    let latestSequence: number | null = null;
    for (const event of events) {
        if (event.event_type !== eventType) {
            continue;
        }
        const sequence = event.integrity?.task_sequence ?? event.sequence;
        if (typeof sequence !== 'number' || !Number.isFinite(sequence)) {
            continue;
        }
        latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
    }
    return latestSequence;
}

function isLatestCompletionCurrent(eventsRoot: string, taskId: string): boolean {
    const latestCompletionSequence = getLatestTimelineSequence(eventsRoot, taskId, 'COMPLETION_GATE_PASSED');
    if (latestCompletionSequence == null) {
        return false;
    }
    const latestTaskModeSequence = getLatestTimelineSequence(eventsRoot, taskId, 'TASK_MODE_ENTERED');
    return latestTaskModeSequence == null || latestCompletionSequence >= latestTaskModeSequence;
}

function getStringField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const rawValue = source?.[field];
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    return value || fallback;
}

function getNumberField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const value = source?.[field];
    return Number.isInteger(value) ? String(value) : fallback;
}

function buildOrchestratorWorkRestartCommand(
    cliPrefix: string,
    taskId: string,
    taskMode: Record<string, unknown> | null
): string {
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--entry-mode ${quoteCommandValue(getStringField(taskMode, 'entry_mode', 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quoteCommandValue(getNumberField(taskMode, 'requested_depth', '<1|2|3>'))}`,
        `--task-summary ${quoteCommandValue(getStringField(taskMode, 'task_summary', '<TASK.md summary>'))}`,
        `--start-banner ${quoteCommandValue(getStringField(taskMode, 'start_banner', '<repo-owned-banner>'))}`,
        `--provider ${quoteCommandValue(getStringField(taskMode, 'provider', '<provider>'))}`
    ];
    const routedTo = getStringField(taskMode, 'routed_to', '');
    if (routedTo) {
        parts.push(`--routed-to ${quoteCommandValue(routedTo)}`);
    }
    parts.push('--orchestrator-work');
    const plannedChangedFiles = Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    for (const plannedChangedFile of plannedChangedFiles) {
        parts.push(`--planned-changed-file ${quoteCommandValue(plannedChangedFile)}`);
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function getTaskModePlannedChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    return Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
}

function getPreflightRefreshChangedFiles(
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null
): string[] {
    const plannedChangedFiles = getTaskModePlannedChangedFiles(taskMode);
    if (plannedChangedFiles.length > 0) {
        return plannedChangedFiles;
    }
    const detectionSource = String(preflight?.detection_source || '').trim().toLowerCase();
    if (detectionSource === 'explicit_changed_files') {
        return getPreflightChangedFiles(preflight);
    }
    return [];
}

function buildClassifyChangeCommand(params: {
    cliPrefix: string;
    taskId: string;
    taskMode: Record<string, unknown> | null;
    preflightCommandPath: string;
    includePlannedScope: boolean;
    changedFiles?: string[];
}): string {
    const parts = [
        `${params.cliPrefix} gate classify-change`,
        `--task-id ${quoteCommandValue(params.taskId)}`,
        `--task-intent ${quoteCommandValue(getStringField(params.taskMode, 'task_summary', '<task summary>'))}`
    ];
    const changedFiles = params.changedFiles || (params.includePlannedScope
        ? getTaskModePlannedChangedFiles(params.taskMode)
        : []);
    for (const changedFile of changedFiles) {
        parts.push(`--changed-file ${quoteCommandValue(changedFile)}`);
    }
    parts.push(`--output-path ${quoteCommandValue(params.preflightCommandPath)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function getPreflightTriggers(preflight: Record<string, unknown> | null): Record<string, unknown> {
    return isPlainRecord(preflight?.triggers) ? preflight.triggers : {};
}

function preflightTouchesProtectedControlPlane(preflight: Record<string, unknown> | null): boolean {
    const triggers = getPreflightTriggers(preflight);
    if (triggers.protected_control_plane_changed === true) {
        return true;
    }
    return Array.isArray(triggers.changed_protected_files) && triggers.changed_protected_files.length > 0;
}

function buildResult(params: {
    taskId: string;
    navigatorCommand: string;
    status: NextStepStatus;
    nextGate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missingArtifacts: NextStepArtifactState[];
    presentArtifacts: NextStepArtifactState[];
    fullSuite: NextStepFullSuiteSummary;
    review: NextStepReviewSummary;
    auditStatus: TaskAuditSummaryResult['status'];
}): NextStepResult {
    const missingArtifacts = params.status === 'DONE' ? [] : params.missingArtifacts;
    return {
        schema_version: 1,
        task_id: params.taskId,
        generated_utc: new Date().toISOString(),
        navigator_command: params.navigatorCommand,
        status: params.status,
        next_gate: params.nextGate,
        title: params.title,
        reason: params.reason,
        commands: params.commands,
        missing_artifacts: missingArtifacts,
        present_artifacts: params.presentArtifacts,
        full_suite_validation: params.fullSuite,
        review: params.review,
        audit_status: params.auditStatus
    };
}

function buildTaskEntryRulePackCommand(repoRoot: string, cliPrefix: string, taskId: string): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "TASK_ENTRY"',
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/00-core.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/40-commands.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/80-task-workflow.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/90-skill-catalog.md')}"`,
        '--repo-root "."'
    ].join(' ');
}

function getEffectiveDepthForPostPreflightRules(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): number {
    const riskAwareDepth = isPlainRecord(preflight?.risk_aware_depth) ? preflight.risk_aware_depth : null;
    const preflightDepth = typeof riskAwareDepth?.effective_depth === 'number'
        ? riskAwareDepth.effective_depth
        : Number(riskAwareDepth?.effective_depth);
    if (Number.isInteger(preflightDepth) && preflightDepth >= 1) {
        return preflightDepth;
    }
    const taskModeDepth = typeof taskMode?.effective_depth === 'number'
        ? taskMode.effective_depth
        : Number(taskMode?.effective_depth);
    if (Number.isInteger(taskModeDepth) && taskModeDepth >= 1) {
        return taskModeDepth;
    }
    return 2;
}

function getPostPreflightRuleFileNames(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): string[] {
    const fileNames = new Set<string>([
        '00-core.md',
        '40-commands.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ]);
    const requiredReviews = isPlainRecord(preflight?.required_reviews) ? preflight.required_reviews : {};
    const effectiveDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (required !== true) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }
    return [...fileNames].sort();
}

function buildPostPreflightRulePackCommandForFiles(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    ruleFileNames: string[]
): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "POST_PREFLIGHT"',
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        ...ruleFileNames.map((fileName) => (
            `--loaded-rule-file "${buildBundleRelativePath(repoRoot, `live/docs/agent-rules/${fileName}`)}"`
        )),
        '--repo-root "."'
    ].join(' ');
}

function resolveRulePackStage(rulePack: Record<string, unknown> | null): string | null {
    const latestStage = typeof rulePack?.latest_stage === 'string'
        ? rulePack.latest_stage.trim()
        : '';
    if (latestStage) {
        return latestStage;
    }
    return typeof rulePack?.stage === 'string' ? rulePack.stage.trim() || null : null;
}

export function resolveNextStep(options: NextStepOptions): NextStepResult {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(options.taskId);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const cliPrefix = buildCliPrefix(repoRoot);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflightCommandPath = buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`);
    const navigatorCommand = buildNavigatorCommand(cliPrefix, taskId);
    const rulePackPath = path.join(reviewsRoot, `${taskId}-rule-pack.json`);
    const preflight = safeReadJson(preflightPath);
    const rulePack = safeReadJson(rulePackPath);
    const taskMode = safeReadJson(path.join(reviewsRoot, `${taskId}-task-mode.json`));
    const taskEntry = readTaskQueueEntry(repoRoot, taskId);
    const defaultExecutionProvider = resolveProviderFromEnvironment();
    const summary = buildTaskAuditSummary({
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot
    });
    const fullSuiteConfig = loadFullSuiteValidationConfig(repoRoot);
    const fullSuiteSummary: NextStepFullSuiteSummary = {
        enabled: fullSuiteConfig.enabled,
        command: fullSuiteConfig.command,
        config_path: toRepoDisplayPath(repoRoot, resolveWorkflowConfigPath(repoRoot)),
        config_source: 'effective_workflow_config',
        note: fullSuiteConfig.enabled
            ? 'Full-suite validation is mandatory because the effective workflow config enables it.'
            : 'Full-suite validation is disabled in the effective workflow config.'
    };
    const requiredReviewTypes = getRequiredReviewTypes(summary.required_reviews);
    const reviewPolicy = resolveReviewPolicy(preflight);
    const preflightSha256 = fileExists(preflightPath) ? fileSha256(preflightPath) : null;
    const reviewStates = requiredReviewTypes.map((reviewType) => (
        readReviewArtifactState(reviewsRoot, taskId, reviewType, preflightPath, preflightSha256)
    ));
    const nextReview = getNextReviewType(
        requiredReviewTypes,
        reviewPolicy.mode,
        summary.required_reviews,
        reviewStates,
        eventsRoot,
        taskId
    );
    const reviewTrust = readReviewTrust(reviewsRoot, taskId, requiredReviewTypes, summary.scope_category);
    const reviewSummary: NextStepReviewSummary = {
        required_reviews: requiredReviewTypes,
        review_execution_policy_mode: reviewPolicy.mode,
        review_execution_policy_source: reviewPolicy.source,
        next_review_type: nextReview.reviewType,
        blocked_review_dependencies: nextReview.blockedDependencies,
        trust: reviewTrust,
        trust_note: reviewTrust?.visible_summary_line || (
            requiredReviewTypes.length > 0
                ? 'Review trust is unavailable until required review receipts exist.'
                : null
        )
    };
    const coreArtifacts = artifactState(repoRoot, [
        { key: 'task-mode', path: path.join(reviewsRoot, `${taskId}-task-mode.json`) },
        { key: 'rule-pack', path: rulePackPath },
        { key: 'handshake', path: path.join(reviewsRoot, `${taskId}-handshake.json`) },
        { key: 'shell-smoke', path: path.join(reviewsRoot, `${taskId}-shell-smoke.json`) },
        { key: 'preflight', path: preflightPath },
        { key: 'compile-gate', path: path.join(reviewsRoot, `${taskId}-compile-gate.json`) },
        { key: 'review-gate', path: path.join(reviewsRoot, `${taskId}-review-gate.json`) },
        { key: 'doc-impact', path: path.join(reviewsRoot, `${taskId}-doc-impact.json`) },
        { key: 'full-suite-validation', path: path.join(reviewsRoot, `${taskId}-full-suite-validation.json`) },
        { key: 'completion-gate', path: path.join(reviewsRoot, `${taskId}-completion-gate.json`) }
    ]);

    const resultBase = {
        taskId,
        navigatorCommand,
        missingArtifacts: coreArtifacts.missing,
        presentArtifacts: coreArtifacts.present,
        fullSuite: fullSuiteSummary,
        review: reviewSummary,
        auditStatus: summary.status
    };

    if (isGatePassed(summary, 'completion-gate') && isLatestCompletionCurrent(eventsRoot, taskId)) {
        return buildResult({
            ...resultBase,
            status: 'DONE',
            nextGate: null,
            title: 'Task gate flow is complete.',
            reason: 'Completion gate passed. Use task-audit-summary for final reporting and commit guidance.',
            commands: [
                buildCommand(
                    'Build final audit summary',
                    `${cliPrefix} gate task-audit-summary --task-id "${taskId}" --repo-root "."`
                )
            ]
        });
    }

    if (!isGatePassed(summary, 'enter-task-mode')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Enter task mode first.',
            reason: defaultExecutionProvider
                ? 'No TASK_MODE_ENTERED event exists for this task.'
                : 'No TASK_MODE_ENTERED event exists for this task, and runtime provider could not be detected from GARDA_EXECUTION_PROVIDER or known provider environment markers. Set GARDA_EXECUTION_PROVIDER to the current execution provider before running the command; do not use SourceOfTruth as a runtime-provider fallback.',
            commands: [
                buildCommand(
                    'Enter task mode',
                    buildEnterTaskModeCommand(cliPrefix, taskId, taskEntry, defaultExecutionProvider)
                )
            ]
        });
    }

    const startupCycleReadiness = readStartupCycleReadiness(eventsRoot, taskId);
    if (!startupCycleReadiness.ready) {
        const command = startupCycleReadiness.nextGate === 'load-rule-pack'
            ? buildTaskEntryRulePackCommand(repoRoot, cliPrefix, taskId)
            : startupCycleReadiness.nextGate === 'handshake-diagnostics'
                ? `${cliPrefix} gate handshake-diagnostics --task-id "${taskId}" --repo-root "."`
                : `${cliPrefix} gate shell-smoke-preflight --task-id "${taskId}" --repo-root "."`;
        const label = startupCycleReadiness.nextGate === 'load-rule-pack'
            ? 'Load TASK_ENTRY rules'
            : startupCycleReadiness.nextGate === 'handshake-diagnostics'
                ? 'Run handshake diagnostics'
                : 'Run shell smoke preflight';
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: startupCycleReadiness.nextGate,
            title: startupCycleReadiness.title,
            reason: startupCycleReadiness.reason,
            commands: [buildCommand(label, command)]
        });
    }

    if (!isGatePassed(summary, 'load-rule-pack') || resolveRulePackStage(rulePack) !== 'TASK_ENTRY' && !preflight) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files.',
            reason: 'Task execution must record the loaded core workflow rule pack before preflight.',
            commands: [buildCommand('Load TASK_ENTRY rules', buildTaskEntryRulePackCommand(repoRoot, cliPrefix, taskId))]
        });
    }

    if (!isGatePassed(summary, 'handshake-diagnostics')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics.',
            reason: 'Runtime identity and reviewer launchability have not been recorded.',
            commands: [
                buildCommand('Run handshake diagnostics', `${cliPrefix} gate handshake-diagnostics --task-id "${taskId}" --repo-root "."`)
            ]
        });
    }

    if (!isGatePassed(summary, 'shell-smoke-preflight')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight.',
            reason: 'CLI launchability and filesystem probes have not been recorded.',
            commands: [
                buildCommand('Run shell smoke preflight', `${cliPrefix} gate shell-smoke-preflight --task-id "${taskId}" --repo-root "."`)
            ]
        });
    }

    if (!preflight || !isGatePassed(summary, 'classify-change')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Classify the task scope.',
            reason: 'No current preflight artifact exists, so required reviews and compile scope are unknown.',
            commands: [
                buildCommand(
                    'Classify changed files',
                    buildClassifyChangeCommand({
                        cliPrefix,
                        taskId,
                        taskMode,
                        preflightCommandPath,
                        includePlannedScope: true
                    })
                )
            ]
        });
    }

    const preflightCycleReadiness = readPreflightCycleReadiness(eventsRoot, taskId);
    if (!preflightCycleReadiness.ready) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight for the current task cycle.',
            reason: preflightCycleReadiness.reason,
            commands: [
                buildCommand(
                    'Refresh preflight',
                    buildClassifyChangeCommand({
                        cliPrefix,
                        taskId,
                        taskMode,
                        preflightCommandPath,
                        includePlannedScope: false,
                        changedFiles: getPreflightRefreshChangedFiles(taskMode, preflight)
                    })
                )
            ]
        });
    }

    if (
        preflightTouchesProtectedControlPlane(preflight)
        && !taskMode?.orchestrator_work
    ) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Restart task mode as orchestrator work.',
            reason: 'The current preflight touches protected orchestrator control-plane files, but task-mode evidence does not declare --orchestrator-work.',
            commands: [
                buildCommand(
                    'Restart task mode with orchestrator work',
                    buildOrchestratorWorkRestartCommand(cliPrefix, taskId, taskMode)
                )
            ]
        });
    }

    const preflightWorkspaceReadiness = preflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight)
        : { ready: false, reason: 'No current preflight exists.' };
    if (!preflightWorkspaceReadiness.ready) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight for the current workspace.',
            reason: preflightWorkspaceReadiness.reason,
            commands: [
                buildCommand(
                    'Refresh preflight',
                    buildClassifyChangeCommand({
                        cliPrefix,
                        taskId,
                        taskMode,
                        preflightCommandPath,
                        includePlannedScope: false,
                        changedFiles: getPreflightRefreshChangedFiles(taskMode, preflight)
                    })
                )
            ]
        });
    }

    const coherentCycleReadiness = readCoherentCycleReadiness(
        repoRoot,
        eventsRoot,
        reviewsRoot,
        taskId,
        preflightPath
    );
    if (!coherentCycleReadiness.ready) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'restart-coherent-cycle',
            title: 'Restart the latest coherent task cycle.',
            reason: coherentCycleReadiness.reason,
            commands: [
                buildCommand(
                    'Restart coherent cycle',
                    coherentCycleReadiness.command || navigatorCommand
                )
            ]
        });
    }

    const postPreflightRulePackReadiness = readPostPreflightRulePackReadiness(
        repoRoot,
        taskId,
        preflightPath,
        rulePackPath
    );
    if (resolveRulePackStage(rulePack) !== 'POST_PREFLIGHT' || !postPreflightRulePackReadiness.ready) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'load-rule-pack',
            title: 'Record POST_PREFLIGHT rule files.',
            reason: postPreflightRulePackReadiness.ready
                ? 'Preflight exists; downstream rule files and risk-specific packs must be recorded for the current scope.'
                : postPreflightRulePackReadiness.reason,
            commands: [
                buildCommand(
                    'Load POST_PREFLIGHT rules',
                    buildPostPreflightRulePackCommandForFiles(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        getPostPreflightRuleFileNames(preflight, taskMode)
                    )
                )
            ]
        });
    }

    const compileReadiness = preflight
        ? readCompileReadiness(repoRoot, reviewsRoot, taskId, preflightPath)
        : { ready: false, reason: 'No current preflight exists.' };
    if (!isGatePassed(summary, 'compile-gate') || !compileReadiness.ready) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'compile-gate',
            title: 'Run compile gate.',
            reason: compileReadiness.reason,
            commands: [
                buildCommand(
                    'Run compile gate',
                    `${cliPrefix} gate compile-gate --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    if (nextReview.reviewType) {
        const reviewType = nextReview.reviewType;
        const state = reviewStates.find((candidate) => candidate.reviewType === reviewType);
        const currentReviewerInvocationAttested = state
            ? timelineHasDelegatedReviewInvocationAttestation(eventsRoot, taskId, state)
            : false;
        const currentReviewContextInvocationAttested = state
            ? timelineHasDelegatedReviewInvocationForCurrentContext(eventsRoot, taskId, state)
            : false;
        const currentReviewContextPrepared = state
            ? timelineHasReviewContextPreparedAfterCompile(eventsRoot, taskId, reviewType, state.contextPath)
            : false;
        const dependencies = nextReview.blockedDependencies;
        if (dependencies.length > 0) {
            const dependencyDetails = describeBlockedReviewDependencies(dependencies, reviewStates);
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Review '${reviewType}' is waiting for upstream review evidence.`,
                reason: `Configured review policy '${reviewPolicy.mode}' requires upstream PASS evidence before '${reviewType}': ${dependencyDetails}. Do not launch '${reviewType}' reviewer until those dependencies pass.`,
                commands: [
                    buildCommand(
                        'Finish upstream review first',
                        navigatorCommand
                    )
                ]
            });
        }
        if (state?.failed && currentReviewerInvocationAttested) {
            const downstreamReviewTypes = getDownstreamReviewTypesFor(
                reviewType,
                requiredReviewTypes,
                summary.required_reviews,
                reviewPolicy.mode
            );
            const downstreamText = downstreamReviewTypes.length > 0
                ? ` Dependent reviews currently blocked by this failure: ${downstreamReviewTypes.join(', ')}.`
                : '';
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'implementation',
                title: `Fix failed '${reviewType}' review findings before continuing.`,
                reason:
                    `Recorded '${reviewType}' review verdict is '${state.verdictToken || state.failToken || 'FAILED'}'. ` +
                    `Do not launch downstream reviewers or rerun '${reviewType}' before implementation changes are made. ` +
                    `Fix the findings, rerun compile-gate, then rebuild and rerun '${reviewType}' review.${downstreamText}`,
                commands: [
                    buildCommand(
                        'Rerun navigator after fixing implementation',
                        navigatorCommand
                    )
                ]
            });
        }
        if (state?.failed && !currentReviewerInvocationAttested && !currentReviewContextPrepared) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Refresh '${reviewType}' review context after implementation changes.`,
                reason:
                    `A previous '${reviewType}' review recorded '${state.verdictToken || state.failToken || 'FAILED'}', ` +
                    'but that failed-review routing is no longer current after the latest compile cycle. ' +
                    `Rebuild '${reviewType}' review context and launch a fresh reviewer before any dependent reviews.`,
                commands: [
                    buildCommand(
                        'Build review context',
                        `${cliPrefix} gate build-review-context --review-type "${reviewType}" --depth "${getEffectiveDepthForPostPreflightRules(preflight, taskMode)}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                    )
                ]
            });
        }
        if (!state || !state.contextExists || !state.contextCurrent) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Prepare '${reviewType}' review context.`,
                reason: !state || !state.contextExists
                    ? `Required review '${reviewType}' has no canonical review-context artifact.`
                    : `Required review '${reviewType}' review-context artifact is stale for the current preflight.`,
                commands: [
                    buildCommand(
                        'Build review context',
                        `${cliPrefix} gate build-review-context --review-type "${reviewType}" --depth "${getEffectiveDepthForPostPreflightRules(preflight, taskMode)}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                    )
                ]
            });
        }
        const contextReviewerIdentity = state.contextReviewerIdentity || '';
        if (
            !contextReviewerIdentity.startsWith('agent:')
            || !timelineHasDelegatedReviewRoutingAfterCompile(eventsRoot, taskId, reviewType, contextReviewerIdentity)
        ) {
            const reviewerIdentity = contextReviewerIdentity || '<agent:reviewer-session-id-from-delegated-agent>';
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-routing',
                title: `Record '${reviewType}' delegated reviewer routing.`,
                reason: `Required review '${reviewType}' needs current REVIEWER_DELEGATION_ROUTED telemetry after the latest compile pass before a review receipt can be recorded. ${REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION} ${REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION}`,
                commands: [
                    buildCommand(
                        'Record fresh delegated review routing',
                        `${cliPrefix} gate record-review-routing --task-id "${taskId}" --review-type "${reviewType}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --repo-root "."`
                    )
                ]
            });
        }
        if (
            !currentReviewContextInvocationAttested
            && (
                !state.artifactExists
                || !state.receiptExists
                || state.reviewerIdentity !== state.contextReviewerIdentity
            )
        ) {
            const reviewerIdentity = state.contextReviewerIdentity
                || '<agent:reviewer-session-id-from-review-context>';
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-invocation',
                title: `Record '${reviewType}' delegated reviewer launch attestation.`,
                reason: `Required review '${reviewType}' needs current REVIEWER_INVOCATION_ATTESTED launch telemetry before reviewer output can become independent review evidence. Record it only from the real delegated reviewer launch artifact for this review context.`,
                commands: [
                    buildCommand(
                        'Record delegated reviewer launch attestation',
                        `${cliPrefix} gate record-review-invocation --task-id "${taskId}" --review-type "${reviewType}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --reviewer-launch-artifact-path ".review-temp/${taskId}/${reviewType}/reviewer-launch.json" --repo-root "."`
                    )
                ]
            });
        }
        if (!currentReviewerInvocationAttested) {
            const reviewerIdentity = state.contextReviewerIdentity
                || '<agent:reviewer-session-id-from-review-context>';
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-result',
                title: `Record '${reviewType}' review result from a delegated reviewer.`,
                reason: `Required review '${reviewType}' has stale or invalid reviewer_provenance; matching REVIEWER_INVOCATION_ATTESTED launch telemetry is missing for the current receipt, so rerun reviewer output materialization after valid launch telemetry exists. Expected PASS token: ${state.passToken || '<review-pass-token>'}. ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`,
                commands: [
                    buildCommand(
                        'Record delegated review output, then close reviewer',
                        `${cliPrefix} gate record-review-result --task-id "${taskId}" --review-type "${reviewType}" --preflight-path "${preflightCommandPath}" --review-output-path ".review-temp/${taskId}/${reviewType}/review-output.md" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --repo-root "."`
                    )
                ]
            });
        }
        if (!state.ready) {
            const stateViolations = state.violations.length > 0
                ? state.violations.join('; ')
                : 'review artifact or receipt is missing';
            const reviewerIdentity = state.contextReviewerIdentity
                || '<agent:reviewer-session-id-from-review-context>';
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-result',
                title: `Record '${reviewType}' review result from a delegated reviewer.`,
                reason: `Required review '${reviewType}' needs a valid delegated artifact and receipt (${stateViolations}). Expected PASS token: ${state.passToken || '<review-pass-token>'}. ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`,
                commands: [
                    buildCommand(
                        'Record delegated review output, then close reviewer',
                        `${cliPrefix} gate record-review-result --task-id "${taskId}" --review-type "${reviewType}" --preflight-path "${preflightCommandPath}" --review-output-path ".review-temp/${taskId}/${reviewType}/review-output.md" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --repo-root "."`
                    )
                ]
            });
        }
    }

    if (!isGatePassed(summary, 'required-reviews-check')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'required-reviews-check',
            title: 'Run required reviews check.',
            reason: 'All required review artifacts appear present, but the review gate has not validated them.',
            commands: [
                buildCommand(
                    'Run required reviews check',
                    `${cliPrefix} gate required-reviews-check --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    if (!isGatePassed(summary, 'doc-impact-gate')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'doc-impact-gate',
            title: 'Record documentation impact.',
            reason: 'Completion requires an explicit docs decision.',
            commands: [
                buildCommand(
                    'Run doc impact gate',
                    buildDocImpactCommand(cliPrefix, taskId, preflightCommandPath, preflight, repoRoot)
                )
            ]
        });
    }

    if (fullSuiteConfig.enabled && !isGatePassed(summary, 'full-suite-validation')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: 'Run full-suite validation.',
            reason: `Effective workflow config enables full-suite validation at ${fullSuiteSummary.config_path}. Command: ${fullSuiteConfig.command}.`,
            commands: [
                buildCommand(
                    'Run full-suite validation',
                    `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    if (!isGatePassed(summary, 'completion-gate')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'completion-gate',
            title: 'Run completion gate.',
            reason: 'All upstream gates appear ready; completion has not finalized the task.',
            commands: [
                buildCommand(
                    'Run completion gate',
                    `${cliPrefix} gate completion-gate --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    return buildResult({
        ...resultBase,
        status: 'BLOCKED',
        nextGate: 'completion-gate',
        title: 'Rerun completion gate for the current task cycle.',
        reason: 'A previous completion gate pass exists, but it is older than the latest task-mode entry. Continue the restarted task cycle before treating the task as DONE.',
        commands: [
            buildCommand(
                'Run completion gate',
                `${cliPrefix} gate completion-gate --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
            )
        ]
    });
}

export function formatNextStepText(result: NextStepResult): string {
    const lines = [
        'GARDA_NEXT_STEP',
        `Task: ${result.task_id}`,
        `Navigator: ${result.navigator_command}`,
        'Loop: run the Navigator first, rerun it after every suggested command, and follow only the single Commands entry it prints.',
        `Status: ${result.status}`,
        `NextGate: ${result.next_gate || 'none'}`,
        `Title: ${result.title}`,
        `Reason: ${result.reason}`,
        `FullSuite: enabled=${result.full_suite_validation.enabled}; command="${result.full_suite_validation.command}"; config=${result.full_suite_validation.config_path}`,
        `ReviewPolicy: ${result.review.review_execution_policy_mode} (${result.review.review_execution_policy_source})`
    ];
    if (result.review.required_reviews.length > 0) {
        lines.push(`RequiredReviews: ${result.review.required_reviews.join(', ')}`);
    } else {
        lines.push('RequiredReviews: none');
    }
    if (result.review.next_review_type) {
        lines.push(`NextReview: ${result.review.next_review_type}`);
    }
    if (result.review.blocked_review_dependencies.length > 0) {
        lines.push(`ReviewBlockedBy: ${result.review.blocked_review_dependencies.join(', ')}`);
        lines.push(`BlockedReviewerLaunches: do not prepare or launch '${result.review.next_review_type}' until current-cycle ${result.review.blocked_review_dependencies.join(', ')} review artifacts and receipts pass.`);
    }
    if (result.review.trust_note) {
        lines.push(result.review.trust_note);
    }
    if (result.missing_artifacts.length > 0) {
        lines.push(`MissingArtifacts: ${result.missing_artifacts.map((artifact) => artifact.key).join(', ')}`);
    }
    lines.push('');
    lines.push('Commands:');
    for (const command of result.commands) {
        lines.push(`  ${command.label}: ${command.command}`);
    }
    if (result.status !== 'DONE') {
        lines.push(`AfterCommand: rerun ${result.navigator_command} after the command above completes.`);
    }
    return `${lines.join('\n')}\n`;
}

function parseTaskIdFromPreflightPath(preflightPath: string): string | null {
    const basename = path.basename(preflightPath).trim();
    const suffix = '-preflight.json';
    if (!basename.endsWith(suffix)) {
        return null;
    }
    return basename.slice(0, -suffix.length) || null;
}

function pickConsistentTaskId(candidates: Array<{ source: string; value: string | null }>): string {
    const normalized = candidates
        .map((candidate) => ({
            source: candidate.source,
            value: String(candidate.value || '').trim()
        }))
        .filter((candidate) => candidate.value);
    const uniqueValues = [...new Set(normalized.map((candidate) => candidate.value))];
    if (uniqueValues.length > 1) {
        throw new Error(`Conflicting task identifiers for next-step: ${normalized.map((candidate) => `${candidate.source}=${candidate.value}`).join(', ')}.`);
    }
    return uniqueValues[0] || '';
}

export function resolveNextStepFromCliOptions(options: {
    taskId?: unknown;
    repoRoot?: unknown;
    eventsRoot?: unknown;
    reviewsRoot?: unknown;
    preflightPath?: unknown;
    positionals?: unknown;
}): NextStepResult {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const positionals = Array.isArray(options.positionals)
        ? options.positionals.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const preflightPathText = String(options.preflightPath || '').trim();
    const resolvedPreflightPath = preflightPathText
        ? resolvePathInsideRepo(preflightPathText, repoRoot, { allowMissing: true })
        : null;
    const taskId = pickConsistentTaskId([
        { source: '--task-id', value: String(options.taskId || '').trim() || null },
        { source: 'positional', value: positionals[0] || null },
        { source: '--preflight-path', value: resolvedPreflightPath ? parseTaskIdFromPreflightPath(resolvedPreflightPath) : null }
    ]);
    const reviewsRoot = options.reviewsRoot
        ? resolvePathInsideRepo(String(options.reviewsRoot), repoRoot, { allowMissing: true })
        : resolvedPreflightPath
            ? path.dirname(resolvedPreflightPath)
        : null;
    const eventsRoot = options.eventsRoot
        ? resolvePathInsideRepo(String(options.eventsRoot), repoRoot, { allowMissing: true })
        : null;
    return resolveNextStep({
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot
    });
}
