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
import { buildReviewTrustSummary, type ReviewTrustSummary } from './review-trust-summary';

export interface TaskQueueMetadata {
    area: string | null;
    title: string | null;
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
            title: cells[4] || null
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

export function readReviewTrustSummary(
    requiredReviews: Record<string, boolean>,
    reviewsRoot: string,
    taskId: string,
    scopeCategory: string | null,
    preflightSha256?: string | null,
    reviewContextPaths?: Record<string, string | null>
): FinalCloseoutReviewTrustSummary | null {
    const requiredReviewTypes = Object.keys(requiredReviews).filter((reviewType) => requiredReviews[reviewType] === true).sort();
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
        const reviewContextPath = reviewContextPaths?.[reviewType]
            ? path.resolve(reviewContextPaths[reviewType] || '')
            : path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
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
            const actualReviewContextHash = fs.existsSync(reviewContextPath) ? fileSha256(reviewContextPath) : null;
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
