import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256, joinOrchestratorPath, resolvePathInsideRepo, toPosix } from './helpers';
import {
    computeOptionalSkillTaskTextSha256,
    getActivatedCurrentCycleOptionalSkillReferenceLoads,
    getOptionalSkillSelectionArtifactViolations,
    isOptionalSkillSelectionPolicyConfigured,
    readOptionalSkillSelectionPolicyConfig,
    type OptionalSkillSelectionArtifactData,
    type OptionalSkillSelectionTimelineEvidence
} from '../runtime/optional-skill-selection';
import { normalizeReviewReceiptReviewerProvenance } from '../gate-runtime/review-context';
import { buildReviewTrustSummary, type ReviewTrustSummary } from './review-trust-summary';
import {
    validateHistoricalReviewRecordedTelemetryEventMatch,
    validateStrictReusedReviewEvidence,
    type ReviewReuseTelemetryEventLike
} from './review-reuse-telemetry';

export interface TaskQueueMetadata {
    area: string | null;
    title: string | null;
    profile: string | null;
}

export interface GateOutcome {
    gate: string;
    status: 'PASS' | 'FAIL' | 'MISSING';
    event_type?: string;
    timestamp_utc?: string | null;
    artifact_path?: string | null;
}

export interface EvidenceArtifact {
    kind: string;
    path: string;
    exists: boolean;
    sha256: string | null;
}

export interface BlockerEntry {
    gate: string;
    reason: string;
}

export interface FinalReportContract {
    status: 'READY' | 'NOT_READY';
    blocker: string | null;
    required_order: string[];
    implementation_summary_requirements: string[];
    commit_command_template: string;
    commit_command_suggestion: string;
    commit_question: string;
}

export interface FinalCloseoutArtifactPaths {
    json: string;
    markdown: string;
}

export interface FinalCloseoutDocsSummary {
    decision: string | null;
    behavior_changed: boolean;
    changelog_updated: boolean;
    docs_updated: string[];
}

export interface FinalCloseoutImplementationSummary {
    requested_depth: number | null;
    effective_depth: number | null;
    path_mode: string | null;
    review_verdicts: Record<string, string>;
    docs_updated: boolean;
    changed_files_count: number;
    changed_lines_total: number;
    scope_category: string | null;
    active_profile: string | null;
}

export interface FinalCloseoutReviewTrustSummary extends ReviewTrustSummary {}

export interface FinalCloseoutReviewIntegrityAttestation {
    schema_version: 1;
    enforcement_mode: 'ADVISORY' | 'BLOCKING';
    status: 'INDEPENDENT_REVIEW_ATTESTED' | 'NO_REVIEW_REQUIRED' | 'DEGRADED_OR_UNVERIFIABLE';
    required_review_count: number;
    required_review_types: string[];
    independent_review_completed: boolean;
    completion_review_attested: boolean;
    completion_review_attestation_not_required: boolean;
    completion_allowed: boolean;
    fake_or_fallback_artifacts_observed: boolean; same_agent_fallback_observed: boolean;
    fallback_artifacts_observed: boolean; legacy_local_review_observed: boolean;
    missing_or_unverifiable_artifacts_observed: boolean; fabricated_artifacts_observed: boolean;
    observed_issues: string[]; reason: string; visible_summary_line: string; final_report_lines: string[];
}

function formatReviewIntegrityObservationLines(input: {
    fakeOrFallbackArtifactsObserved: boolean;
    sameAgentFallbackObserved: boolean;
    fallbackArtifactsObserved: boolean;
    legacyLocalReviewObserved: boolean;
    missingOrUnverifiableObserved: boolean;
    fabricatedArtifactsObserved: boolean;
}): string[] {
    return [
        `Fake/fallback artifacts observed: ${input.fakeOrFallbackArtifactsObserved ? 'yes' : 'no'}.`,
        `Same-agent fallback observed: ${input.sameAgentFallbackObserved ? 'yes' : 'no'}.`,
        `Fallback artifacts observed: ${input.fallbackArtifactsObserved ? 'yes' : 'no'}.`,
        `Legacy local review observed: ${input.legacyLocalReviewObserved ? 'yes' : 'no'}.`,
        `Missing/unverifiable artifacts observed: ${input.missingOrUnverifiableObserved ? 'yes' : 'no'}.`,
        `Fabricated artifacts observed: ${input.fabricatedArtifactsObserved ? 'yes' : 'no'}.`
    ];
}

export interface FinalCloseoutOptionalSkillsSummary {
    policy_mode: string | null;
    decision: string | null;
    selected_skill_ids: string[];
    used_skill_ids: string[];
    recommended_missing_pack_ids: string[];
    as_is_reason: string | null;
    visible_summary_line: string | null;
}

export interface ProfileReviewDecisionSummary {
    profile_name: string | null;
    scope_category: string | null;
    guardrails_active: boolean;
    lightening_eligible: boolean;
    safety_floors_applied: string[];
    decisions: Array<{
        review_type: string;
        effective_value: boolean;
        decision: string;
    }>;
}

const REVIEW_TRUST_COMPATIBILITY_TYPES = [
    'code',
    'db',
    'security',
    'refactor',
    'test',
    'api',
    'performance',
    'infra',
    'dependency'
] as const;
const REVIEW_TRUST_COMPATIBILITY_TYPE_SET = new Set<string>(REVIEW_TRUST_COMPATIBILITY_TYPES);

function normalizeKnownReviewType(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return REVIEW_TRUST_COMPATIBILITY_TYPE_SET.has(normalized) ? normalized : null;
}

export function collectKnownRequiredReviewTypes(requiredReviews: Record<string, boolean>): string[] {
    const reviewTypes = new Set<string>();
    for (const [reviewType, required] of Object.entries(requiredReviews || {})) {
        const normalizedReviewType = normalizeKnownReviewType(reviewType);
        if (required === true && normalizedReviewType) {
            reviewTypes.add(normalizedReviewType);
        }
    }
    return [...reviewTypes].sort();
}

function collectUnsafeRequiredReviewTypeIssues(requiredReviews: Record<string, boolean>): string[] {
    return Object.entries(requiredReviews || {})
        .filter(([reviewType, required]) => required === true && !normalizeKnownReviewType(reviewType))
        .map(([reviewType]) => `unsafe or unknown required review type ignored: ${JSON.stringify(reviewType)}`)
        .sort();
}

export function safeReadJson(filePath: string): Record<string, unknown> | null {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

export function resolveReviewsRoot(repoRoot: string, explicit?: string | null): string {
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (resolved) return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
}

export function resolveEventsRoot(repoRoot: string, explicit?: string | null): string {
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (resolved) return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
}

export function readTaskQueueMetadata(repoRoot: string, taskId: string): TaskQueueMetadata | null {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return null;
    }

    const lines = fs.readFileSync(taskPath, 'utf8').split('\n');
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = trimmed
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim());
        if (cells.length < 9 || cells[0] !== taskId) {
            continue;
        }
        if (cells[0].toLowerCase() === 'id' || cells[0].startsWith('-') || cells[0].startsWith('=')) {
            continue;
        }
        return {
            area: cells[3] || null,
            title: cells[4] || null,
            profile: cells[7] || null
        };
    }

    return null;
}

export function readReviewVerdicts(
    requiredReviews: Record<string, boolean>,
    reviewGate: Record<string, unknown> | null
): Record<string, string> {
    const verdictsSource = reviewGate && reviewGate.verdicts && typeof reviewGate.verdicts === 'object'
        ? reviewGate.verdicts as Record<string, unknown>
        : {};
    const reviewVerdicts: Record<string, string> = {};
    for (const reviewType of Object.keys(requiredReviews).filter((key) => requiredReviews[key]).sort()) {
        const verdict = verdictsSource[reviewType];
        reviewVerdicts[reviewType] = typeof verdict === 'string' && verdict.trim()
            ? verdict.trim()
            : 'MISSING';
    }
    return reviewVerdicts;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTrustToken(value: unknown): string {
    return String(value || '').trim().toUpperCase();
}

function reviewGateMatchesCurrentCycle(
    reviewGate: Record<string, unknown>,
    taskId: string,
    preflightSha256?: string | null
): boolean {
    if (String(reviewGate.task_id || '').trim() !== taskId) {
        return false;
    }
    if (
        normalizeTrustToken(reviewGate.status) !== 'PASSED'
        || normalizeTrustToken(reviewGate.outcome) !== 'PASS'
    ) {
        return false;
    }

    const expectedPreflightSha256 = String(preflightSha256 || '').trim().toLowerCase();
    if (!expectedPreflightSha256) {
        return true;
    }

    return String(reviewGate.preflight_hash_sha256 || '').trim().toLowerCase() === expectedPreflightSha256;
}

function reviewGateCheckIsIndependent(check: Record<string, unknown>): boolean {
    const routingPolicy = isPlainRecord(check.reviewer_routing_policy)
        ? check.reviewer_routing_policy
        : null;
    const reviewerIdentity = String(check.reviewer_identity || '').trim();

    return check.required === true
        && check.skipped_by_override !== true
        && check.receipt_valid === true
        && normalizeTrustToken(check.trust_level) === 'INDEPENDENT_AUDITED'
        && String(check.reviewer_execution_mode || '').trim() === 'delegated_subagent'
        && reviewerIdentity.startsWith('agent:')
        && !String(check.reviewer_fallback_reason || '').trim()
        && !!routingPolicy
        && (
            routingPolicy.delegation_required === true
            && String(routingPolicy.expected_execution_mode || '').trim() === 'delegated_subagent'
            && routingPolicy.fallback_allowed === false
            && routingPolicy.fallback_reason_required === false
        );
}

export function readReviewTrustSummaryFromReviewGate(
    reviewGate: Record<string, unknown> | null,
    requiredReviews: Record<string, boolean>,
    taskId: string,
    scopeCategory: string | null,
    preflightSha256?: string | null
): FinalCloseoutReviewTrustSummary | null {
    const requiredReviewTypes = collectKnownRequiredReviewTypes(requiredReviews);
    if (requiredReviewTypes.length === 0 || !reviewGateMatchesCurrentCycle(reviewGate || {}, taskId, preflightSha256)) {
        return null;
    }

    const reviewGateRequiredReviews = isPlainRecord(reviewGate?.required_reviews)
        ? reviewGate.required_reviews
        : null;
    const reviewChecks = isPlainRecord(reviewGate?.review_checks)
        ? reviewGate.review_checks
        : null;
    if (!reviewGateRequiredReviews || !reviewChecks) {
        return null;
    }

    const executionModes = new Set<string>();
    for (const reviewType of requiredReviewTypes) {
        if (reviewGateRequiredReviews[reviewType] !== true) {
            return null;
        }
        const check = isPlainRecord(reviewChecks[reviewType])
            ? reviewChecks[reviewType] as Record<string, unknown>
            : null;
        if (!check || !reviewGateCheckIsIndependent(check)) {
            return null;
        }
        executionModes.add('DELEGATED_SUBAGENT');
    }

    const scopeLabel = String(scopeCategory || '').trim() ? `${String(scopeCategory).trim()} task` : 'task';
    const formattedModes = [...executionModes].sort().join(', ') || 'unknown execution mode';
    return {
        status: 'INDEPENDENT_AUDITED',
        trust_levels: ['INDEPENDENT_AUDITED'],
        execution_modes: [...executionModes].sort(),
        independent_review_attested: true,
        completion_policy: 'INDEPENDENT_REVIEW_ATTESTED',
        visible_summary_line:
            `Review trust: INDEPENDENT_AUDITED via ${formattedModes}; ` +
            'independent reviewer launch attested.',
        policy_summary_line:
            `Review policy: independent reviewer launch attestation satisfies mandatory review for this ${scopeLabel}.`
    };
}

export function buildUnavailableRequiredReviewTrustSummary(
    requiredReviews: Record<string, boolean>,
    scopeCategory: string | null
): FinalCloseoutReviewTrustSummary | null {
    const requiredReviewCount = Object.values(requiredReviews).filter((value) => value === true).length;
    return buildReviewTrustSummary([], scopeCategory, requiredReviewCount);
}

export function readReviewTrustSummary(
    requiredReviews: Record<string, boolean>,
    reviewsRoot: string,
    taskId: string,
    scopeCategory: string | null,
    preflightSha256?: string | null
): FinalCloseoutReviewTrustSummary | null {
    const requiredReviewTypes = collectKnownRequiredReviewTypes(requiredReviews);
    const compatibilityFallbackActive = requiredReviewTypes.length === 0;
    const compatibilityReviewTypes = requiredReviewTypes.length > 0
        ? requiredReviewTypes
        : REVIEW_TRUST_COMPATIBILITY_TYPES.filter((reviewType) => (
            fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`))
            || fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}.md`))
            || fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`))
        ));
    const entries = compatibilityReviewTypes.flatMap((reviewType) => {
        const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
        const reviewPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
        const reviewContextPath = getCanonicalReviewContextPath(reviewsRoot, taskId, reviewType);
        const receipt = safeReadJson(receiptPath);
        if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) {
            return [];
        }
        if (!fs.existsSync(reviewPath)) {
            return [];
        }
        const actualReviewArtifactHash = fileSha256(reviewPath);
        const recordedReviewArtifactHash = typeof receipt.review_artifact_sha256 === 'string'
            ? receipt.review_artifact_sha256.trim().toLowerCase()
            : '';
        if (!actualReviewArtifactHash) {
            return [];
        }
        if (!recordedReviewArtifactHash && !compatibilityFallbackActive) {
            return [];
        }
        if (recordedReviewArtifactHash && recordedReviewArtifactHash !== actualReviewArtifactHash) {
            return [];
        }
        const expectedPreflightHash = typeof preflightSha256 === 'string'
            ? preflightSha256.trim().toLowerCase()
            : '';
        const recordedPreflightHash = typeof receipt.preflight_sha256 === 'string'
            ? receipt.preflight_sha256.trim().toLowerCase()
            : '';
        if (expectedPreflightHash && (!recordedPreflightHash || recordedPreflightHash !== expectedPreflightHash)) {
            return [];
        }
        const recordedReviewContextHash = typeof receipt.review_context_sha256 === 'string'
            ? receipt.review_context_sha256.trim().toLowerCase()
            : '';
        let contextFallbackReasonRequired: boolean | null = null;
        if (expectedPreflightHash && !recordedReviewContextHash) {
            return [];
        }
        if (recordedReviewContextHash) {
            const actualReviewContextHash = fs.existsSync(reviewContextPath) && isSafeCanonicalArtifactPath(reviewContextPath, reviewsRoot)
                ? fileSha256(reviewContextPath)
                : null;
            if (!actualReviewContextHash || recordedReviewContextHash !== actualReviewContextHash) {
                return [];
            }
            const reviewContext = safeReadJson(reviewContextPath);
            const reviewerRouting = reviewContext && typeof reviewContext.reviewer_routing === 'object'
                ? reviewContext.reviewer_routing as Record<string, unknown>
                : null;
            const contextExecutionMode = reviewerRouting && typeof reviewerRouting.actual_execution_mode === 'string'
                ? reviewerRouting.actual_execution_mode.trim()
                : '';
            const contextReviewerSessionId = reviewerRouting && typeof reviewerRouting.reviewer_session_id === 'string'
                ? reviewerRouting.reviewer_session_id.trim()
                : '';
            const contextFallbackReason = reviewerRouting && typeof reviewerRouting.fallback_reason === 'string'
                ? reviewerRouting.fallback_reason.trim()
                : '';
            const contextCapabilityLevel = reviewerRouting && typeof reviewerRouting.capability_level === 'string'
                ? reviewerRouting.capability_level.trim()
                : '';
            const contextDelegationRequired = reviewerRouting?.delegation_required === true;
            const contextExpectedExecutionMode = reviewerRouting && typeof reviewerRouting.expected_execution_mode === 'string'
                ? reviewerRouting.expected_execution_mode.trim()
                : '';
            const contextFallbackAllowed = reviewerRouting && typeof reviewerRouting.fallback_allowed === 'boolean'
                ? reviewerRouting.fallback_allowed
                : null;
            contextFallbackReasonRequired = reviewerRouting && typeof reviewerRouting.fallback_reason_required === 'boolean'
                ? reviewerRouting.fallback_reason_required
                : null;
            const invalidContextIdentityScope =
                contextExecutionMode !== 'delegated_subagent'
                || !contextReviewerSessionId.startsWith('agent:');
            const invalidContextPolicy =
                (contextDelegationRequired && contextExecutionMode !== 'delegated_subagent')
                || contextCapabilityLevel === 'single_agent_only'
                || contextExpectedExecutionMode === 'same_agent_fallback'
                || contextFallbackAllowed === true
                || contextFallbackReasonRequired === true
                || !!contextFallbackReason;
            const receiptExecutionMode = typeof receipt.reviewer_execution_mode === 'string'
                ? receipt.reviewer_execution_mode.trim()
                : '';
            const receiptReviewerIdentity = typeof receipt.reviewer_identity === 'string'
                ? receipt.reviewer_identity.trim()
                : '';
            const receiptFallbackReason = typeof receipt.reviewer_fallback_reason === 'string'
                ? receipt.reviewer_fallback_reason.trim()
                : '';
            if (
                !contextExecutionMode
                || !contextReviewerSessionId
                || invalidContextIdentityScope
                || invalidContextPolicy
            ) {
                return [];
            }
            if (receiptExecutionMode && receiptExecutionMode !== 'delegated_subagent') {
                return [];
            }
            if (receiptExecutionMode && receiptExecutionMode !== contextExecutionMode) {
                return [];
            }
            if (receiptReviewerIdentity && !receiptReviewerIdentity.startsWith('agent:')) {
                return [];
            }
            if (receiptReviewerIdentity && receiptReviewerIdentity !== contextReviewerSessionId) {
                return [];
            }
            if (receiptFallbackReason) {
                return [];
            }
        }
        return [{
            review_type: reviewType,
            trust_level: typeof receipt.trust_level === 'string' ? receipt.trust_level : null,
            reviewer_execution_mode: typeof receipt.reviewer_execution_mode === 'string' ? receipt.reviewer_execution_mode : null,
            reviewer_identity: typeof receipt.reviewer_identity === 'string' ? receipt.reviewer_identity : null,
            reviewer_fallback_reason: typeof receipt.reviewer_fallback_reason === 'string' ? receipt.reviewer_fallback_reason : null,
            reviewer_fallback_reason_required: contextFallbackReasonRequired,
            reviewer_provenance: receipt.reviewer_provenance ?? null
        }];
    });
    return buildReviewTrustSummary(entries, scopeCategory, compatibilityReviewTypes.length);
}

function reviewLooksFabricated(content: string): boolean {
    const normalized = String(content || '');
    return /^\s*(?:this\s+is\s+)?(?:a\s+)?(?:fake|fabricated)\s+review[.!]?\s*$/imu.test(normalized) || /^\s*(?:obviously synthetic|placeholder review|todo review)\b/imu.test(normalized) || /\b(?:review output|review artifact)\s*:\s*(?:fake|fabricated|placeholder|todo)\b/iu.test(normalized);
}

function normalizeSha256Text(value: unknown): string {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(text) ? text : '';
}

function pathInsideOrEqual(candidatePath: string, rootPath: string): boolean {
    const relative = path.relative(rootPath, candidatePath);
    return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isSafeCanonicalArtifactPath(filePath: string, rootPath: string): boolean {
    const resolvedFilePath = path.resolve(filePath);
    const resolvedRootPath = path.resolve(rootPath);
    if (!pathInsideOrEqual(resolvedFilePath, resolvedRootPath)) {
        return false;
    }
    if (!fs.existsSync(resolvedFilePath)) {
        return true;
    }
    const realRootPath = fs.existsSync(resolvedRootPath)
        ? fs.realpathSync.native(resolvedRootPath)
        : resolvedRootPath;
    const realFilePath = fs.realpathSync.native(resolvedFilePath);
    return pathInsideOrEqual(realFilePath, realRootPath);
}

function getCanonicalReviewContextPath(reviewsRoot: string, taskId: string, reviewType: string): string {
    return path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
}

function readEventTaskSequence(event: ReviewReuseTelemetryEventLike): number | null {
    const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
    const sequence = typeof integrity?.task_sequence === 'number'
        ? integrity.task_sequence
        : Number(integrity?.task_sequence);
    return Number.isInteger(sequence) ? sequence : null;
}

function findLatestEventTaskSequenceForTypes(
    events: readonly ReviewReuseTelemetryEventLike[] | undefined,
    eventTypes: readonly string[]
): number | null {
    if (!events) {
        return null;
    }
    const normalizedEventTypes = new Set(eventTypes.map((eventType) => eventType.trim().toUpperCase()));
    let latestSequence: number | null = null;
    for (const event of events) {
        if (!normalizedEventTypes.has(String(event.event_type || '').trim().toUpperCase())) {
            continue;
        }
        const sequence = readEventTaskSequence(event);
        if (sequence != null) {
            latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
        }
    }
    return latestSequence;
}

function findFreshReviewTelemetryIssue(options: {
    reviewType: string; repoRoot: string | null | undefined; taskId: string; events: readonly ReviewReuseTelemetryEventLike[] | undefined;
    latestCompileTaskSequence: number | null; latestReviewGateTaskSequence: number | null; receiptPath: string; receiptSha256: string; receipt: Record<string, unknown>;
    reviewContextSha256: string; reviewTreeStateSha256: string; reviewArtifactSha256: string; reviewerExecutionMode: string; reviewerIdentity: string; reviewerProvenance: Record<string, unknown> | null;
}): string | null {
    if (!options.repoRoot) {
        return `${options.reviewType}: fresh review evidence cannot be validated without repo root`;
    }
    if (!options.events) {
        return `${options.reviewType}: fresh review evidence cannot be validated without task timeline`;
    }
    if (options.latestCompileTaskSequence == null) {
        return `${options.reviewType}: fresh review evidence cannot locate current compile telemetry`;
    }
    if (options.latestReviewGateTaskSequence == null) {
        return `${options.reviewType}: fresh review evidence cannot locate current required-reviews gate telemetry`;
    }
    if (options.latestReviewGateTaskSequence <= options.latestCompileTaskSequence) {
        return `${options.reviewType}: current required-reviews gate telemetry is not after the current compile telemetry`;
    }
    let lastReason: string | null = null;
    for (const event of [...options.events].sort((left, right) =>
        (readEventTaskSequence(right) ?? 0) - (readEventTaskSequence(left) ?? 0)
    )) {
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEW_RECORDED') {
            continue;
        }
        const taskSequence = readEventTaskSequence(event);
        if (taskSequence != null && taskSequence <= options.latestCompileTaskSequence) {
            continue;
        }
        if (taskSequence != null && taskSequence >= options.latestReviewGateTaskSequence) {
            return `${options.reviewType}: review recorded after current required-reviews gate`;
        }
        const match = validateHistoricalReviewRecordedTelemetryEventMatch({
            event,
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            receiptPath: options.receiptPath,
            receiptSha256: options.receiptSha256,
            reviewContextSha256: options.reviewContextSha256,
            reviewContextReuseSha256: normalizeSha256Text(options.receipt.review_context_reuse_sha256) || undefined,
            reviewTreeStateSha256: options.reviewTreeStateSha256 || undefined,
            reviewScopeSha256: normalizeSha256Text(options.receipt.review_scope_sha256) || undefined,
            codeScopeSha256: normalizeSha256Text(options.receipt.code_scope_sha256) || undefined,
            reviewArtifactSha256: options.reviewArtifactSha256,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewerProvenance: options.reviewerProvenance,
            maxTaskSequenceExclusive: options.latestReviewGateTaskSequence,
            verifyReceiptSnapshot: true
        });
        if (match.matched) {
            return findFreshReviewerInvocationTelemetryIssue({
                ...options,
                events: options.events,
                latestReviewRecordedTaskSequence: taskSequence
            });
        }
        if (match.reason && match.reason !== 'wrong_event_type') {
            lastReason = match.reason;
        }
    }
    return `${options.reviewType}: missing current-cycle REVIEW_RECORDED telemetry or snapshot binding` +
        `${lastReason ? ` (${lastReason})` : ''}`;
}

function findFreshReviewerInvocationTelemetryIssue(options: {
    reviewType: string; taskId: string; events: readonly ReviewReuseTelemetryEventLike[]; latestCompileTaskSequence: number | null; latestReviewRecordedTaskSequence: number | null;
    reviewerExecutionMode: string; reviewerIdentity: string; reviewContextSha256: string; reviewTreeStateSha256: string; reviewerProvenance: Record<string, unknown> | null;
}): string | null {
    const provenance = normalizeReviewReceiptReviewerProvenance(options.reviewerProvenance);
    if (!provenance || provenance.attestation_type !== 'reviewer_invocation_attestation') {
        return `${options.reviewType}: missing matching REVIEWER_INVOCATION_ATTESTED telemetry`;
    }
    if (provenance.task_id !== options.taskId || provenance.review_type !== options.reviewType || provenance.reviewer_execution_mode !== options.reviewerExecutionMode || provenance.reviewer_identity !== options.reviewerIdentity || provenance.review_context_sha256 !== options.reviewContextSha256 || (options.reviewTreeStateSha256 && provenance.review_tree_state_sha256 !== options.reviewTreeStateSha256)) {
        return `${options.reviewType}: reviewer invocation provenance does not match receipt`;
    }
    for (const event of options.events) {
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEWER_INVOCATION_ATTESTED') { continue; }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : {};
        const taskSequence = readEventTaskSequence(event);
        if (taskSequence == null || taskSequence <= (options.latestCompileTaskSequence ?? 0) || (options.latestReviewRecordedTaskSequence != null && taskSequence >= options.latestReviewRecordedTaskSequence)) { continue; }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventReviewTreeStateSha256 = normalizeSha256Text(details.review_tree_state_sha256 ?? details.reviewTreeStateSha256);
        if (taskSequence === provenance.task_sequence && normalizeSha256Text(integrity.event_sha256) === provenance.event_sha256 && (integrity.prev_event_sha256 == null ? null : normalizeSha256Text(integrity.prev_event_sha256)) === provenance.prev_event_sha256 && String(details.task_id ?? details.taskId ?? '').trim() === options.taskId && String(details.review_type ?? details.reviewType ?? '').trim().toLowerCase() === options.reviewType && String(details.reviewer_execution_mode ?? details.reviewerExecutionMode ?? '').trim() === options.reviewerExecutionMode && String(details.reviewer_identity ?? details.reviewerIdentity ?? details.reviewer_session_id ?? details.reviewerSessionId ?? '').trim() === options.reviewerIdentity && normalizeSha256Text(details.review_context_sha256 ?? details.reviewContextSha256) === options.reviewContextSha256 && (!options.reviewTreeStateSha256 || eventReviewTreeStateSha256 === options.reviewTreeStateSha256) && normalizeSha256Text(details.routing_event_sha256 ?? details.routingEventSha256) === provenance.routing_event_sha256) { return null; }
    }
    return `${options.reviewType}: missing matching REVIEWER_INVOCATION_ATTESTED telemetry`;
}

function reviewIntegrityArtifactExists(reviewsRoot: string, taskId: string, reviewType: string): boolean {
    return fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`)) || fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}.md`)) || fs.existsSync(path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`));
}

function discoverReviewIntegrityObservationTypes(reviewsRoot: string, taskId: string): string[] {
    return REVIEW_TRUST_COMPATIBILITY_TYPES.filter((reviewType) => reviewIntegrityArtifactExists(reviewsRoot, taskId, reviewType)).sort();
}

function collectReviewIntegrityIssues(options: {
    requiredReviewTypes: string[]; reviewsRoot: string; taskId: string; preflightSha256?: string | null;
    repoRoot?: string | null; timelineEvents?: readonly ReviewReuseTelemetryEventLike[]; strictVerification: boolean; initialIssues?: string[];
}): string[] {
    const issues: string[] = [...(options.initialIssues || [])];
    const expectedPreflightSha256 = String(options.preflightSha256 || '').trim().toLowerCase();
    const latestCompileTaskSequence = findLatestEventTaskSequenceForTypes(options.timelineEvents, ['COMPILE_GATE_PASSED']);
    const latestReviewGateTaskSequence = findLatestEventTaskSequenceForTypes(
        options.timelineEvents,
        ['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE']
    );
    for (const reviewType of options.requiredReviewTypes) {
        const receiptPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}-receipt.json`);
        const reviewPath = path.join(options.reviewsRoot, `${options.taskId}-${reviewType}.md`);
        const reviewContextPath = getCanonicalReviewContextPath(options.reviewsRoot, options.taskId, reviewType);
        const reviewContextPathSafe = isSafeCanonicalArtifactPath(reviewContextPath, options.reviewsRoot);
        const receipt = safeReadJson(receiptPath);
        const reviewExists = fs.existsSync(reviewPath) && fs.statSync(reviewPath).isFile();
        const receiptExists = fs.existsSync(receiptPath) && fs.statSync(receiptPath).isFile();
        const contextExists = fs.existsSync(reviewContextPath) && fs.statSync(reviewContextPath).isFile();
        const reviewContent = reviewExists ? fs.readFileSync(reviewPath, 'utf8') : '';

        if (reviewExists && reviewLooksFabricated(reviewContent)) {
            issues.push(`${reviewType}: fabricated-looking review artifact content observed`);
        }
        if (!receipt || receipt.task_id !== options.taskId || receipt.review_type !== reviewType) {
            if (options.strictVerification || reviewExists || receiptExists || contextExists) {
                issues.push(`${reviewType}: missing or invalid review receipt`);
            }
            continue;
        }
        if (!reviewExists) {
            issues.push(`${reviewType}: missing review artifact`);
        }
        const receiptExecutionMode = String(receipt.reviewer_execution_mode || '').trim();
        const receiptReviewerIdentity = String(receipt.reviewer_identity || '').trim();
        const receiptFallbackReason = String(receipt.reviewer_fallback_reason || '').trim();
        const receiptTrustLevel = normalizeTrustToken(receipt.trust_level);
        const reusedExistingReview = receipt.reused_existing_review === true;
        const recordedReviewContextHash = String(receipt.review_context_sha256 || '').trim().toLowerCase();
        if (receiptExecutionMode === 'same_agent_fallback') {
            issues.push(`${reviewType}: same_agent_fallback review receipt observed`);
        } else if (receiptExecutionMode && receiptExecutionMode !== 'delegated_subagent') {
            issues.push(`${reviewType}: unverifiable reviewer execution mode '${receiptExecutionMode}'`);
        }
        if (!receiptReviewerIdentity) {
            issues.push(`${reviewType}: receipt omits reviewer identity`);
        } else if (receiptReviewerIdentity.startsWith('self:')) {
            issues.push(`${reviewType}: same_agent_fallback/self-scoped reviewer identity observed`);
        } else if (receiptExecutionMode === 'delegated_subagent' && !receiptReviewerIdentity.startsWith('agent:')) {
            issues.push(`${reviewType}: unverifiable reviewer identity '${receiptReviewerIdentity}'`);
        }
        if (receiptFallbackReason) {
            issues.push(`${reviewType}: fallback reason recorded on review receipt`);
        }
        if (receiptTrustLevel === 'LOCAL_ASSERTED' || receiptTrustLevel === 'LOCAL_AUDITED') {
            issues.push(`${reviewType}: legacy or local trust receipt '${receiptTrustLevel}' observed`);
        } else if (receiptTrustLevel !== 'INDEPENDENT_AUDITED') {
            issues.push(`${reviewType}: missing independent trust receipt`);
        }
        const provenance = receipt.reviewer_provenance == null
            ? null
            : normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
        if (!provenance || provenance.attestation_type !== 'reviewer_invocation_attestation') {
            issues.push(`${reviewType}: missing independent reviewer invocation provenance`);
        } else {
            const provenanceTaskId = provenance.task_id;
            const provenanceReviewType = provenance.review_type;
            const provenanceExecutionMode = provenance.reviewer_execution_mode;
            const provenanceReviewerIdentity = provenance.reviewer_identity;
            const provenanceReviewContextHash = provenance.review_context_sha256;
            const reusedFromReviewContextHash = normalizeSha256Text(receipt.reused_from_review_context_sha256);
            const expectedProvenanceReviewContextHash = reusedExistingReview
                ? reusedFromReviewContextHash || recordedReviewContextHash
                : recordedReviewContextHash;
            if (reusedExistingReview && !reusedFromReviewContextHash) {
                issues.push(`${reviewType}: reused review receipt omits reused review context hash`);
            }
            if (provenanceTaskId !== options.taskId) {
                issues.push(`${reviewType}: reviewer provenance task id does not match receipt task`);
            }
            if (provenanceReviewType !== reviewType) {
                issues.push(`${reviewType}: reviewer provenance review type does not match receipt review type`);
            }
            if (provenanceExecutionMode !== receiptExecutionMode) {
                issues.push(`${reviewType}: reviewer provenance execution mode does not match receipt`);
            }
            if (provenanceReviewerIdentity !== receiptReviewerIdentity) {
                issues.push(`${reviewType}: reviewer provenance identity does not match receipt`);
            }
            if (!provenanceReviewerIdentity) {
                issues.push(`${reviewType}: reviewer provenance omits reviewer identity`);
            } else if (provenanceReviewerIdentity.startsWith('self:')) {
                issues.push(`${reviewType}: same_agent_fallback/self-scoped reviewer provenance observed`);
            }
            if (!provenanceReviewContextHash) {
                issues.push(`${reviewType}: reviewer provenance omits review context hash`);
            } else if (expectedProvenanceReviewContextHash && provenanceReviewContextHash !== expectedProvenanceReviewContextHash) {
                issues.push(`${reviewType}: reviewer provenance review context hash does not match receipt`);
            }
        }
        const recordedReviewArtifactHash = String(receipt.review_artifact_sha256 || '').trim().toLowerCase();
        if (reviewExists && recordedReviewArtifactHash && fileSha256(reviewPath) !== recordedReviewArtifactHash) {
            issues.push(`${reviewType}: review artifact hash does not match receipt`);
        }
        if (reviewExists && !recordedReviewArtifactHash) {
            issues.push(`${reviewType}: receipt omits review artifact hash`);
        }
        const recordedPreflightHash = String(receipt.preflight_sha256 || '').trim().toLowerCase();
        if (expectedPreflightSha256 && recordedPreflightHash !== expectedPreflightSha256) {
            issues.push(`${reviewType}: receipt preflight hash does not match current preflight`);
        }
        if (!recordedReviewContextHash) {
            issues.push(`${reviewType}: receipt omits review context hash`);
        } else if (!reviewContextPathSafe || !fs.existsSync(reviewContextPath) || fileSha256(reviewContextPath) !== recordedReviewContextHash) {
            issues.push(`${reviewType}: review context hash is missing or does not match receipt`);
        }
        const reviewContext = reviewContextPathSafe ? safeReadJson(reviewContextPath) : null;
        const reviewContextTreeState = isPlainRecord(reviewContext?.tree_state)
            ? reviewContext?.tree_state as Record<string, unknown>
            : null;
        const reviewContextTreeStateHash = normalizeSha256Text(
            reviewContextTreeState?.tree_state_sha256 ?? reviewContextTreeState?.treeStateSha256
        );
        const receiptReviewTreeStateHash = normalizeSha256Text(receipt.review_tree_state_sha256);
        const reusedFromReviewTreeStateHash = normalizeSha256Text(receipt.reused_from_review_tree_state_sha256);
        if (reusedExistingReview) {
            if (!options.repoRoot) {
                issues.push(`${reviewType}: reused review evidence cannot be validated without repo root`);
            } else if (!options.timelineEvents) {
                issues.push(`${reviewType}: reused review evidence cannot be validated without task timeline`);
            } else {
                const strictReuseValidation = validateStrictReusedReviewEvidence({
                    repoRoot: options.repoRoot,
                    taskId: options.taskId,
                    reviewType,
                    events: options.timelineEvents,
                    receiptPath,
                    receiptSha256: fileSha256(receiptPath),
                    reviewContextSha256: recordedReviewContextHash,
                    reviewContextReuseSha256: normalizeSha256Text(receipt.review_context_reuse_sha256),
                    reviewTreeStateSha256: receiptReviewTreeStateHash,
                    reviewScopeSha256: normalizeSha256Text(receipt.review_scope_sha256),
                    codeScopeSha256: normalizeSha256Text(receipt.code_scope_sha256),
                    reviewArtifactSha256: recordedReviewArtifactHash,
                    reusedFromReceiptPath: String(receipt.reused_from_receipt_path || '').trim() || null,
                    reusedFromReceiptSha256: normalizeSha256Text(receipt.reused_from_receipt_sha256),
                    reusedFromReviewContextSha256: normalizeSha256Text(receipt.reused_from_review_context_sha256),
                    reusedFromReviewContextReuseSha256: normalizeSha256Text(receipt.reused_from_review_context_reuse_sha256),
                    reusedFromReviewTreeStateSha256: reusedFromReviewTreeStateHash,
                    reusedFromReviewScopeSha256: normalizeSha256Text(receipt.reused_from_review_scope_sha256),
                    reusedFromCodeScopeSha256: normalizeSha256Text(receipt.reused_from_code_scope_sha256),
                    reviewerExecutionMode: receiptExecutionMode,
                    reviewerIdentity: receiptReviewerIdentity,
                    reviewerProvenance: isPlainRecord(receipt.reviewer_provenance) ? receipt.reviewer_provenance : null,
                    latestCompileTaskSequence
                });
                if (!strictReuseValidation.valid) {
                    issues.push(`${reviewType}: strict reused review evidence is invalid: ${strictReuseValidation.reason}`);
                } else if (
                    latestReviewGateTaskSequence == null
                    || strictReuseValidation.currentReuseEventTaskSequence >= latestReviewGateTaskSequence
                ) {
                    issues.push(`${reviewType}: reused review evidence was recorded after the current required-reviews gate`);
                }
            }
        } else {
            const telemetryIssue = findFreshReviewTelemetryIssue({
                reviewType,
                repoRoot: options.repoRoot,
                taskId: options.taskId,
                events: options.timelineEvents,
                latestCompileTaskSequence,
                latestReviewGateTaskSequence,
                receiptPath,
                receiptSha256: fileSha256(receiptPath) || '',
                receipt: receipt as Record<string, unknown>,
                reviewContextSha256: recordedReviewContextHash,
                reviewTreeStateSha256: receiptReviewTreeStateHash,
                reviewArtifactSha256: recordedReviewArtifactHash,
                reviewerExecutionMode: receiptExecutionMode,
                reviewerIdentity: receiptReviewerIdentity,
                reviewerProvenance: isPlainRecord(receipt.reviewer_provenance) ? receipt.reviewer_provenance : null
            });
            if (telemetryIssue) {
                issues.push(telemetryIssue);
            }
        }
        if (reviewContextTreeStateHash && !receiptReviewTreeStateHash) {
            issues.push(`${reviewType}: receipt omits review tree-state hash`);
        } else if (reviewContextTreeStateHash && receiptReviewTreeStateHash !== reviewContextTreeStateHash) {
            issues.push(`${reviewType}: receipt review tree-state hash does not match review context`);
        }
        if (reusedExistingReview && !reusedFromReviewTreeStateHash) {
            issues.push(`${reviewType}: reused review receipt omits reused review tree-state hash`);
        }
        if (provenance?.attestation_type === 'reviewer_invocation_attestation') {
            const expectedProvenanceReviewTreeStateHash = reusedExistingReview
                ? reusedFromReviewTreeStateHash || receiptReviewTreeStateHash || reviewContextTreeStateHash
                : receiptReviewTreeStateHash || reviewContextTreeStateHash;
            if (expectedProvenanceReviewTreeStateHash && !provenance.review_tree_state_sha256) {
                issues.push(`${reviewType}: reviewer provenance omits review tree-state hash`);
            } else if (
                expectedProvenanceReviewTreeStateHash
                && provenance.review_tree_state_sha256
                && provenance.review_tree_state_sha256 !== expectedProvenanceReviewTreeStateHash
            ) {
                issues.push(`${reviewType}: reviewer provenance review tree-state hash does not match receipt`);
            }
        }
        const reviewerRouting = isPlainRecord(reviewContext?.reviewer_routing)
            ? reviewContext?.reviewer_routing as Record<string, unknown>
            : null;
        if (!reviewerRouting) {
            issues.push(`${reviewType}: missing review context reviewer routing metadata`);
        } else if (reusedExistingReview) {
            // Reused reviews intentionally bind trust through historical receipt/provenance/reuse fields.
            // The current review-context can leave fresh launch routing fields empty for reuse evidence.
        } else {
            const contextExecutionMode = String(reviewerRouting.actual_execution_mode || '').trim();
            const contextReviewerSessionId = String(reviewerRouting.reviewer_session_id || '').trim();
            const contextFallbackReason = String(reviewerRouting.fallback_reason || '').trim();
            const contextDelegationRequired = reviewerRouting.delegation_required === true;
            const contextExpectedExecutionMode = String(reviewerRouting.expected_execution_mode || '').trim();
            const contextFallbackAllowed = reviewerRouting.fallback_allowed;
            const contextFallbackReasonRequired = reviewerRouting.fallback_reason_required;
            if (!contextExecutionMode) {
                issues.push(`${reviewType}: review context omits reviewer routing execution mode`);
            }
            if (!contextReviewerSessionId) {
                issues.push(`${reviewType}: review context omits reviewer routing identity`);
            }
            if (contextDelegationRequired !== true) {
                issues.push(`${reviewType}: review context does not require delegated reviewer routing`);
            }
            if (contextExpectedExecutionMode !== 'delegated_subagent') {
                issues.push(`${reviewType}: review context expected execution mode is not delegated_subagent`);
            }
            if (contextFallbackAllowed !== false || contextFallbackReasonRequired !== false) {
                issues.push(`${reviewType}: fallback-capable review context routing observed`);
            }
            if (contextExecutionMode === 'same_agent_fallback') {
                issues.push(`${reviewType}: same_agent_fallback review context routing observed`);
            } else if (contextExecutionMode && contextExecutionMode !== 'delegated_subagent') {
                issues.push(`${reviewType}: unverifiable review context execution mode '${contextExecutionMode}'`);
            }
            if (!reusedExistingReview && receiptExecutionMode && contextExecutionMode && receiptExecutionMode !== contextExecutionMode) {
                issues.push(`${reviewType}: review context execution mode does not match receipt`);
            }
            if (!reusedExistingReview && contextReviewerSessionId && receiptReviewerIdentity && contextReviewerSessionId !== receiptReviewerIdentity) {
                issues.push(`${reviewType}: review context reviewer identity does not match receipt`);
            }
            if (contextExecutionMode === 'delegated_subagent' && contextReviewerSessionId.startsWith('self:')) {
                issues.push(`${reviewType}: same_agent_fallback/self-scoped review context routing observed`);
            } else if (contextExecutionMode === 'delegated_subagent' && contextReviewerSessionId && !contextReviewerSessionId.startsWith('agent:')) {
                issues.push(`${reviewType}: unverifiable review context reviewer identity '${contextReviewerSessionId}'`);
            }
            if (reviewerRouting.fallback_allowed === true || reviewerRouting.fallback_reason_required === true || contextFallbackReason) {
                issues.push(`${reviewType}: fallback-capable review context routing observed`);
            }
        }
    }
    return [...new Set(issues)].sort((left, right) => left.localeCompare(right));
}

export function buildReviewIntegrityAttestation(options: {
    requiredReviews: Record<string, boolean>; reviewsRoot: string; taskId: string; scopeCategory: string | null; preflightSha256?: string | null;
    reviewTrustSummary: FinalCloseoutReviewTrustSummary | null; repoRoot?: string | null; timelineEvents?: readonly ReviewReuseTelemetryEventLike[];
}): FinalCloseoutReviewIntegrityAttestation {
    const requiredReviewTypes = collectKnownRequiredReviewTypes(options.requiredReviews);
    const unsafeRequiredReviewTypeIssues = collectUnsafeRequiredReviewTypeIssues(options.requiredReviews);
    const rawRequiredReviewCount = Object.values(options.requiredReviews || {}).filter((required) => required === true).length;
    const requiredReviewCount = requiredReviewTypes.length;
    const observationReviewTypes = requiredReviewCount > 0
        ? requiredReviewTypes
        : discoverReviewIntegrityObservationTypes(options.reviewsRoot, options.taskId);
    const independentReviewCompleted =
        options.reviewTrustSummary?.status === 'INDEPENDENT_AUDITED'
        && options.reviewTrustSummary.independent_review_attested === true;
    const strictVerification = requiredReviewCount > 0;
    const observedIssues = collectReviewIntegrityIssues({
        requiredReviewTypes: observationReviewTypes,
        reviewsRoot: options.reviewsRoot,
        taskId: options.taskId,
        preflightSha256: options.preflightSha256,
        repoRoot: options.repoRoot,
        timelineEvents: options.timelineEvents,
        strictVerification,
        initialIssues: unsafeRequiredReviewTypeIssues
    });
    const issueText = observedIssues.join('\n').toLowerCase();
    const sameAgentFallbackObserved = issueText.includes('same_agent_fallback') || issueText.includes('self-scoped');
    const fallbackArtifactsObserved = sameAgentFallbackObserved || issueText.includes('fallback');
    const legacyLocalReviewObserved = issueText.includes('legacy or local trust') || issueText.includes('local_');
    const missingOrUnverifiableObserved =
        issueText.includes('missing')
        || issueText.includes('unverifiable')
        || issueText.includes('invalid')
        || issueText.includes('does not match')
        || issueText.includes('omits');
    const fabricatedArtifactsObserved = issueText.includes('fabricated-looking');
    const fakeOrFallbackObserved = fabricatedArtifactsObserved || fallbackArtifactsObserved;

    if (rawRequiredReviewCount === 0 && observedIssues.length === 0) {
        const reason = 'No mandatory review was required for this scope; completion is allowed but is not review-attested.';
        return {
            schema_version: 1,
            enforcement_mode: 'ADVISORY',
            status: 'NO_REVIEW_REQUIRED',
            required_review_count: 0,
            required_review_types: [],
            independent_review_completed: false,
            completion_review_attested: false,
            completion_review_attestation_not_required: true,
            completion_allowed: true,
            fake_or_fallback_artifacts_observed: fakeOrFallbackObserved,
            same_agent_fallback_observed: sameAgentFallbackObserved,
            fallback_artifacts_observed: fallbackArtifactsObserved,
            legacy_local_review_observed: legacyLocalReviewObserved,
            missing_or_unverifiable_artifacts_observed: missingOrUnverifiableObserved,
            fabricated_artifacts_observed: fabricatedArtifactsObserved,
            observed_issues: observedIssues,
            reason,
            visible_summary_line:
                'Review integrity: no mandatory review required; completion allowed without review attestation; ' +
                `fake/fallback/unverifiable artifacts observed=${observedIssues.length > 0 ? 'yes' : 'no'}; enforcement=advisory.`,
            final_report_lines: [
                'Review integrity: no mandatory independent review was required for this scope.',
                'Review integrity enforcement: advisory; this summary reports trust state but does not apply completion blocking.',
                'Independent review completed: not required.',
                'Completion review-attested: no (not required).',
                ...formatReviewIntegrityObservationLines({
                    fakeOrFallbackArtifactsObserved: fakeOrFallbackObserved,
                    sameAgentFallbackObserved,
                    fallbackArtifactsObserved,
                    legacyLocalReviewObserved,
                    missingOrUnverifiableObserved,
                    fabricatedArtifactsObserved
                }),
                `Completion allowed: yes. Reason: ${reason}`
            ]
        };
    }

    const completionReviewAttested = independentReviewCompleted && observedIssues.length === 0;
    const blockingEnforcementRequired = rawRequiredReviewCount > 0;
    const completionAllowed = !blockingEnforcementRequired || completionReviewAttested;
    const enforcementMode = blockingEnforcementRequired ? 'BLOCKING' : 'ADVISORY';
    const status = completionReviewAttested ? 'INDEPENDENT_REVIEW_ATTESTED' : 'DEGRADED_OR_UNVERIFIABLE';
    const reason = completionReviewAttested
        ? 'All mandatory reviews are independently audited and no fake, fallback, legacy, missing, fabricated, or unverifiable review artifacts were observed.'
        : blockingEnforcementRequired
            ? 'Mandatory review trust is degraded or unverifiable; final closeout is blocked until independent review evidence is current, hash-bound, and telemetry-bound.'
            : 'Review evidence is degraded or unverifiable, but no mandatory review was required for this scope; completion is allowed without review attestation.';
    return {
        schema_version: 1,
        enforcement_mode: enforcementMode,
        status,
        required_review_count: requiredReviewCount,
        required_review_types: requiredReviewTypes,
        independent_review_completed: independentReviewCompleted,
        completion_review_attested: completionReviewAttested,
        completion_review_attestation_not_required: false,
        completion_allowed: completionAllowed,
        fake_or_fallback_artifacts_observed: fakeOrFallbackObserved,
        same_agent_fallback_observed: sameAgentFallbackObserved,
        fallback_artifacts_observed: fallbackArtifactsObserved,
        legacy_local_review_observed: legacyLocalReviewObserved,
        missing_or_unverifiable_artifacts_observed: missingOrUnverifiableObserved,
        fabricated_artifacts_observed: fabricatedArtifactsObserved,
        observed_issues: observedIssues,
        reason,
        visible_summary_line:
            `Review integrity: ${status}; independent_review_completed=${independentReviewCompleted ? 'yes' : 'no'}; ` +
            `completion_review_attested=${completionReviewAttested ? 'yes' : 'no'}; ` +
            `completion_allowed=${completionAllowed ? 'yes' : 'no'}; fake/fallback/unverifiable artifacts observed=${observedIssues.length > 0 ? 'yes' : 'no'}; ` +
            `enforcement=${enforcementMode.toLowerCase()}.`,
        final_report_lines: [
            `Review integrity: ${status}.`,
            completionAllowed
                ? `Review integrity enforcement: ${enforcementMode.toLowerCase()}; this summary reports trust state without blocking final closeout for this scope.`
                : 'Review integrity enforcement: blocking; final closeout is blocked until mandatory review trust is independently attested.',
            `Independent review completed: ${independentReviewCompleted ? 'yes' : 'no'}.`,
            `Completion review-attested: ${completionReviewAttested ? 'yes' : 'no'}.`,
            ...formatReviewIntegrityObservationLines({
                fakeOrFallbackArtifactsObserved: fakeOrFallbackObserved,
                sameAgentFallbackObserved,
                fallbackArtifactsObserved,
                legacyLocalReviewObserved,
                missingOrUnverifiableObserved,
                fabricatedArtifactsObserved
            }),
            `Completion allowed: ${completionAllowed ? 'yes' : 'no'}. Reason: ${reason}`
        ]
    };
}

export function readDocImpactSummary(docImpact: Record<string, unknown> | null): FinalCloseoutDocsSummary {
    const docsUpdated = docImpact && Array.isArray(docImpact.docs_updated)
        ? docImpact.docs_updated.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    return {
        decision: docImpact && typeof docImpact.decision === 'string' ? docImpact.decision : null,
        behavior_changed: docImpact?.behavior_changed === true,
        changelog_updated: docImpact?.changelog_updated === true,
        docs_updated: docsUpdated
    };
}

export function readOptionalSkillsSummary(
    bundleRoot: string,
    preflightPath: string,
    preflightSha256: string | null,
    currentTaskText: string | null,
    invalidateOnMissingTaskRow: boolean,
    optionalSkillsPath: string,
    optionalSkills: Record<string, unknown> | null,
    timelineEvidence: OptionalSkillSelectionTimelineEvidence
): FinalCloseoutOptionalSkillsSummary | null {
    if (!optionalSkills) {
        if (isOptionalSkillSelectionPolicyConfigured(bundleRoot)) {
            const policyMode = readOptionalSkillSelectionPolicyConfig(bundleRoot).mode;
            if (policyMode === 'off') {
                return {
                    policy_mode: policyMode,
                    decision: 'as_is',
                    selected_skill_ids: [],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: [],
                    as_is_reason: 'policy_off',
                    visible_summary_line: 'Optional skills: as_is (reason: policy_off)'
                };
            }
        }
        return null;
    }
    const artifactPolicyMode = String(optionalSkills.policy_mode || '').trim() || null;
    if (!preflightSha256) {
        return {
            policy_mode: artifactPolicyMode,
            decision: 'invalidated',
            selected_skill_ids: [],
            used_skill_ids: [],
            recommended_missing_pack_ids: [],
            as_is_reason: 'artifact_drift',
            visible_summary_line: 'Optional skills: unavailable (reason: artifact_drift)'
        };
    }
    const artifact = {
        artifactPath: optionalSkillsPath,
        payload: optionalSkills
    } as unknown as OptionalSkillSelectionArtifactData;
    const validationOptions: Parameters<typeof getOptionalSkillSelectionArtifactViolations>[2] = {
        requireMaterializedArtifact: true,
        expectedPreflightPath: preflightPath,
        expectedPreflightSha256: preflightSha256,
        validateAgainstCurrentHeadlines: false,
        validateAgainstCurrentInventory: false
    };
    if (currentTaskText != null) {
        validationOptions.expectedTaskTextSha256 = computeOptionalSkillTaskTextSha256(String(currentTaskText || ''));
    } else if (invalidateOnMissingTaskRow) {
        validationOptions.expectedTaskTextSha256 = null;
    }
    const violations = getOptionalSkillSelectionArtifactViolations(bundleRoot, artifact, validationOptions);
    if (violations.length > 0) {
        return {
            policy_mode: artifactPolicyMode,
            decision: 'invalidated',
            selected_skill_ids: [],
            used_skill_ids: [],
            recommended_missing_pack_ids: [],
            as_is_reason: 'artifact_drift',
            visible_summary_line: 'Optional skills: unavailable (reason: artifact_drift)'
        };
    }
    const selectedSkillIds = Array.isArray(optionalSkills.selected_installed_skills)
        ? optionalSkills.selected_installed_skills
            .map((entry) => {
                if (!entry || typeof entry !== 'object') {
                    return null;
                }
                return String((entry as Record<string, unknown>).id || '').trim() || null;
            })
            .filter((entry): entry is string => !!entry)
        : [];
    const recommendedMissingPackIds = Array.isArray(optionalSkills.recommended_missing_packs)
        ? optionalSkills.recommended_missing_packs
            .map((entry) => {
                if (!entry || typeof entry !== 'object') {
                    return null;
                }
                return String((entry as Record<string, unknown>).id || '').trim() || null;
            })
            .filter((entry): entry is string => !!entry)
        : [];
    const visibleSummaryLine = String(optionalSkills.visible_summary_line || '').trim() || null;
    if (timelineEvidence.invalidJson) {
        return {
            policy_mode: artifactPolicyMode,
            decision: 'unavailable',
            selected_skill_ids: selectedSkillIds,
            used_skill_ids: [],
            recommended_missing_pack_ids: recommendedMissingPackIds,
            as_is_reason: 'task_events_integrity',
            visible_summary_line: 'Optional skills: unavailable (reason: task_events_integrity)'
        };
    }
    const currentCycleReferenceLoads = getActivatedCurrentCycleOptionalSkillReferenceLoads(artifact.payload, timelineEvidence);
    const usedSkillIds = selectedSkillIds.filter((entry) => (
        currentCycleReferenceLoads.some((load) => load.skillId === entry)
    ));
    let usageSummaryLine = visibleSummaryLine;
    const reasonMatch = visibleSummaryLine?.match(/\(reason:\s*([^)]+)\)\s*$/i);
    const reasonSuffix = reasonMatch?.[1]?.trim();
    if (selectedSkillIds.length > 0 && usedSkillIds.length === 0) {
        usageSummaryLine = reasonSuffix
            ? `Optional skills: none_used (selected: ${selectedSkillIds.join(', ')}, reason: ${reasonSuffix})`
            : `Optional skills: none_used (selected: ${selectedSkillIds.join(', ')})`;
    } else if (usedSkillIds.length > 0 && usedSkillIds.length !== selectedSkillIds.length) {
        usageSummaryLine = reasonSuffix
            ? `Optional skills: ${usedSkillIds.join(', ')} (reason: ${reasonSuffix})`
            : `Optional skills: ${usedSkillIds.join(', ')}`;
    }
    return {
        policy_mode: artifactPolicyMode,
        decision: String(optionalSkills.decision || '').trim() || null,
        selected_skill_ids: selectedSkillIds,
        used_skill_ids: usedSkillIds,
        recommended_missing_pack_ids: recommendedMissingPackIds,
        as_is_reason: String(optionalSkills.as_is_reason || '').trim() || null,
        visible_summary_line: usageSummaryLine
    };
}

export function updateEvidenceArtifactState(
    evidence: EvidenceArtifact[],
    kind: string,
    artifactPath: string,
    exists: boolean
): void {
    const normalizedPath = toPosix(path.resolve(artifactPath));
    const entry = evidence.find((candidate) => candidate.kind === kind);
    const sha256 = exists ? fileSha256(artifactPath) : null;
    if (entry) {
        entry.path = normalizedPath;
        entry.exists = exists;
        entry.sha256 = sha256;
        return;
    }
    evidence.push({
        kind,
        path: normalizedPath,
        exists,
        sha256
    });
}

export function parseOptionalNumber(value: unknown): number | null {
    if (value == null || value === '') {
        return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
