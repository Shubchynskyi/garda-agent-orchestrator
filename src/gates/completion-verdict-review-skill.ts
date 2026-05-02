import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    normalizeCompatibilityReviewerExecutionMode,
    normalizeReviewReceiptReviewerProvenance,
    type ReviewReceipt
} from '../gate-runtime/review-context';
import {
    DEFAULT_REVIEW_EXECUTION_POLICY_MODE,
    type EffectiveReviewExecutionPolicyMode
} from '../core/review-execution-policy';
import { getReviewSkillCandidates } from '../core/review-capabilities';
import { normalizePath } from './helpers';
import {
    normalizeTimelineDetailString,
    getTimelineSkillId,
    getTimelineReferencePath,
    eventMatchesReviewSkill,
    findLatestTimelineEvent
} from './completion-evidence';
import type { TimelineEventEntry } from './completion-evidence';
import { resolveReviewContextRoutingIdentity } from './review-context-routing';
import {
    getRequiredUpstreamReviewsFromRecord,
    normalizeRequiredReviewRecord
} from './review-dependencies';
import {
    findMatchingHistoricalReviewRecordedTelemetryEvent,
    validateReviewReuseRecordedEventMatch
} from './review-reuse-telemetry';
import { getMandatoryDelegatedReviewTrustViolation } from './review-trust-policy';
import {
    normalizeRuntimeIdentitySource,
    resolveReviewerRoutingPolicy
} from './reviewer-routing';
import { isTrivialReview } from './completion-verdict-findings';

export const REVIEW_CONTRACTS = [
    ['code', 'REVIEW PASSED'],
    ['db', 'DB REVIEW PASSED'],
    ['security', 'SECURITY REVIEW PASSED'],
    ['refactor', 'REFACTOR REVIEW PASSED'],
    ['api', 'API REVIEW PASSED'],
    ['test', 'TEST REVIEW PASSED'],
    ['performance', 'PERFORMANCE REVIEW PASSED'],
    ['infra', 'INFRA REVIEW PASSED'],
    ['dependency', 'DEPENDENCY REVIEW PASSED']
];

/**
 * Validate review-skill evidence for code-changing tasks.
 * When code changed but the review-gate artifact does not carry evidence
 * of actual review-skill invocations (review_checks with non-NOT_REQUIRED verdicts),
 * the completion gate fails.
 */
export function validateReviewSkillEvidence(
    events: TimelineEventEntry[],
    requiredReviews: Record<string, unknown>,
    reviewArtifacts: Record<string, {
        path: string;
        content?: string;
        reviewContext?: Record<string, unknown> | null;
        receipt?: ReviewReceipt | null;
    }>,
    codeChanged: boolean,
    timelinePath: string,
    sourceOfTruth: string | null = null,
    canonicalSourceOfTruth: string | null = null,
    allowLegacyReviewContextIdentityFallback = false,
    executionProviderSource: string | null = null,
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode = DEFAULT_REVIEW_EXECUTION_POLICY_MODE,
    repoRoot: string | null = null
): { skill_ids: string[]; reference_paths: string[]; artifact_keys: string[]; reviewer_execution_modes: string[]; violations: string[] } {
    const result = {
        skill_ids: [] as string[],
        reference_paths: [] as string[],
        artifact_keys: [] as string[],
        reviewer_execution_modes: [] as string[],
        violations: [] as string[]
    };
    if (!codeChanged) return result;

    const normalizedTimelinePath = normalizePath(timelinePath);

    const requiredKeys: string[] = [];
    for (const [key, value] of Object.entries(requiredReviews)) {
        if (value === true) {
            requiredKeys.push(key);
        }
    }

    const compilePassSequence = findLatestTimelineEvent(events, (entry) => entry.event_type === 'COMPILE_GATE_PASSED')?.sequence ?? null;
    const reviewPhaseSequence = findLatestTimelineEvent(events, (entry) => entry.event_type === 'REVIEW_PHASE_STARTED')?.sequence ?? null;
    const reviewGatePassSequence = findLatestTimelineEvent(events, (entry) => (
        entry.event_type === 'REVIEW_GATE_PASSED' || entry.event_type === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
    ))?.sequence ?? null;
    const typedReviewPhaseEventsPresent = events.some((entry) => (
        entry.event_type === 'REVIEW_PHASE_STARTED'
        && normalizeTimelineDetailString(entry.details?.review_type ?? entry.details?.reviewType) !== null
    ));
    const getReviewPhaseSequenceForKey = (reviewKey: string): number | null => {
        const normalizedReviewKey = reviewKey.toLowerCase();
        const matchingTypedPhase = findLatestTimelineEvent(events, (entry) => (
            entry.event_type === 'REVIEW_PHASE_STARTED'
            && normalizeTimelineDetailString(entry.details?.review_type ?? entry.details?.reviewType) === normalizedReviewKey
        ));
        if (matchingTypedPhase) {
            return matchingTypedPhase.sequence;
        }
        if (!typedReviewPhaseEventsPresent) {
            return reviewPhaseSequence;
        }
        return null;
    };
    const reviewPhaseSequenceByKey = new Map<string, number | null>();
    const reviewRecordedEventByKey = new Map<string, TimelineEventEntry | null>();

    if (requiredKeys.length > 0 && reviewPhaseSequence == null) {
        result.violations.push(
            `Task timeline '${normalizedTimelinePath}' is missing REVIEW_PHASE_STARTED. ` +
            'Required review skills must be prepared before review gate completion.'
        );
    }

    const routingPolicy = resolveReviewerRoutingPolicy(sourceOfTruth, executionProviderSource);

    for (const key of requiredKeys) {
        const candidateSkillIds = getReviewSkillCandidates(key);
        const reviewPhaseSequenceForKey = getReviewPhaseSequenceForKey(key);
        reviewPhaseSequenceByKey.set(key, reviewPhaseSequenceForKey);
        const selectionEvent = findLatestTimelineEvent(events, (entry) => (
            entry.event_type === 'SKILL_SELECTED' && eventMatchesReviewSkill(entry, candidateSkillIds)
        ));
        const referenceEvent = findLatestTimelineEvent(events, (entry) => (
            entry.event_type === 'SKILL_REFERENCE_LOADED' && eventMatchesReviewSkill(entry, candidateSkillIds)
        ));
        const recordEvent = findLatestTimelineEvent(events, (entry) => (
            entry.event_type === 'REVIEW_RECORDED' &&
            String(entry.details?.review_type || entry.details?.reviewType || '').toLowerCase() === key.toLowerCase()
        ));
        const recordEventIsReuse = recordEvent?.details?.reused_existing_review === true;
        reviewRecordedEventByKey.set(key, recordEvent);
        const routingEvent = findLatestTimelineEvent(events, (entry) => (
            entry.event_type === 'REVIEWER_DELEGATION_ROUTED' &&
            String(entry.details?.review_type || entry.details?.reviewType || '').toLowerCase() === key.toLowerCase()
        ));

        if (reviewPhaseSequence != null && reviewPhaseSequenceForKey == null) {
            result.violations.push(
                `Task timeline '${normalizedTimelinePath}' is missing REVIEW_PHASE_STARTED for required review '${key}'. ` +
                'Required review skills must be prepared before review gate completion.'
            );
        }

        if (!selectionEvent) {
            result.violations.push(
                `Code-changing task is missing SKILL_SELECTED telemetry for required review '${key}'. ` +
                `Expected one of: ${candidateSkillIds.join(', ')}.`
            );
        } else {
            const selectedSkillId = getTimelineSkillId(selectionEvent) || candidateSkillIds[0];
            if (!result.skill_ids.includes(selectedSkillId)) {
                result.skill_ids.push(selectedSkillId);
            }
            if (compilePassSequence != null && selectionEvent.sequence < compilePassSequence) {
                result.violations.push(
                    `Review skill '${selectedSkillId}' was selected before COMPILE_GATE_PASSED in '${normalizedTimelinePath}'.`
                );
            }
            if (reviewPhaseSequenceForKey != null && selectionEvent.sequence < reviewPhaseSequenceForKey) {
                result.violations.push(
                    `Review skill '${selectedSkillId}' was selected before REVIEW_PHASE_STARTED in '${normalizedTimelinePath}'.`
                );
            }
            if (reviewGatePassSequence != null && selectionEvent.sequence > reviewGatePassSequence) {
                result.violations.push(
                    `Review skill '${selectedSkillId}' was selected after REVIEW_GATE_PASSED in '${normalizedTimelinePath}'.`
                );
            }
        }

        if (!referenceEvent) {
            result.violations.push(
                `Code-changing task is missing SKILL_REFERENCE_LOADED telemetry for required review '${key}'. ` +
                `Expected one of: ${candidateSkillIds.join(', ')}.`
            );
        } else {
            const referencePath = getTimelineReferencePath(referenceEvent);
            if (referencePath && !result.reference_paths.includes(referencePath)) {
                result.reference_paths.push(referencePath);
            }
            if (reviewPhaseSequenceForKey != null && referenceEvent.sequence < reviewPhaseSequenceForKey) {
                result.violations.push(
                    `Review skill reference for '${key}' was loaded before REVIEW_PHASE_STARTED in '${normalizedTimelinePath}'.`
                );
            }
            if (reviewGatePassSequence != null && referenceEvent.sequence > reviewGatePassSequence) {
                result.violations.push(
                    `Review skill reference for '${key}' was loaded after REVIEW_GATE_PASSED in '${normalizedTimelinePath}'.`
                );
            }
        }

        if (!recordEvent) {
            result.violations.push(
                `Code-changing task is missing REVIEW_RECORDED telemetry for required review '${key}'. ` +
                "Review evidence was not officially recorded via 'gate record-review-receipt'."
            );
        } else if (compilePassSequence != null && recordEvent.sequence < compilePassSequence) {
            result.violations.push(
                `Required review '${key}' was recorded before the latest COMPILE_GATE_PASSED in '${normalizedTimelinePath}'. ` +
                `Do not backfill '${key}' review evidence from an older execution cycle.`
            );
        }
        if (!routingEvent && !recordEventIsReuse) {
            result.violations.push(
                `Code-changing task is missing REVIEWER_DELEGATION_ROUTED telemetry for required review '${key}'. ` +
                'Required reviews must record whether delegated fresh-context execution or fallback mode was used.'
            );
        } else if (routingEvent && !recordEventIsReuse) {
            const executionMode = normalizeTimelineDetailString(
                routingEvent.details?.reviewer_execution_mode ?? routingEvent.details?.reviewerExecutionMode
            );
            if (executionMode && !result.reviewer_execution_modes.includes(executionMode)) {
                result.reviewer_execution_modes.push(executionMode);
            }
            if (executionMode === 'delegated_subagent' && !routingEvent.integrity) {
                result.violations.push(
                    `Reviewer routing telemetry for '${key}' is missing integrity in '${normalizedTimelinePath}'. ` +
                    'Delegated review provenance must bind to controller-attested routing telemetry.'
                );
            }
            if (reviewPhaseSequenceForKey != null && routingEvent.sequence < reviewPhaseSequenceForKey) {
                result.violations.push(
                    `Reviewer routing telemetry for '${key}' was emitted before REVIEW_PHASE_STARTED in '${normalizedTimelinePath}'.`
                );
            }
            if (recordEvent && routingEvent.sequence > recordEvent.sequence) {
                result.violations.push(
                    `Reviewer routing telemetry for '${key}' was emitted after REVIEW_RECORDED in '${normalizedTimelinePath}'.`
                );
            }
        }
    }

    const normalizedRequiredReviewRecord = normalizeRequiredReviewRecord(requiredReviews);
    const upstreamRequiredReviewsByKey = new Map<string, string[]>();
    for (const key of requiredKeys) {
        upstreamRequiredReviewsByKey.set(
            key,
            getRequiredUpstreamReviewsFromRecord(key, normalizedRequiredReviewRecord, reviewExecutionPolicyMode)
        );
    }

    for (const key of requiredKeys) {
        const downstreamPhaseSequence = reviewPhaseSequenceByKey.get(key) ?? null;
        if (downstreamPhaseSequence == null) {
            continue;
        }
        const upstreamRequiredReviews = upstreamRequiredReviewsByKey.get(key) || [];
        for (const upstreamKey of upstreamRequiredReviews) {
            const upstreamRecordedEvent = reviewRecordedEventByKey.get(upstreamKey) ?? null;
            if (!upstreamRecordedEvent) {
                result.violations.push(
                    `Required review '${key}' cannot start before upstream review '${upstreamKey}' is recorded in '${normalizedTimelinePath}'. ` +
                    `Run and record '${upstreamKey}' for the current cycle before launching '${key}'.`
                );
                continue;
            }
            if (compilePassSequence != null && upstreamRecordedEvent.sequence < compilePassSequence) {
                result.violations.push(
                    `Required review '${key}' depends on upstream review '${upstreamKey}', but the latest '${upstreamKey}' evidence predates ` +
                    `COMPILE_GATE_PASSED in '${normalizedTimelinePath}'. Re-run or reuse '${upstreamKey}' for the current cycle before '${key}'.`
                );
                continue;
            }
            if (upstreamRecordedEvent.sequence > downstreamPhaseSequence) {
                result.violations.push(
                    `Required review '${key}' started before upstream review '${upstreamKey}' completed in '${normalizedTimelinePath}'. ` +
                    `Downstream '${key}' review must wait for current-cycle '${upstreamKey}' evidence.`
                );
            }
        }
    }

    for (const key of requiredKeys) {
        const artifact = reviewArtifacts[key];
        if (!artifact) {
            result.violations.push(
                `Code-changing task is missing review artifact for required review '${key}'. ` +
                'Review skill must be invoked and produce a review artifact before completion.'
            );
        } else {
            if (!result.artifact_keys.includes(key)) {
                result.artifact_keys.push(key);
            }

            const reviewContext = artifact.reviewContext && typeof artifact.reviewContext === 'object' && !Array.isArray(artifact.reviewContext)
                ? artifact.reviewContext as Record<string, unknown>
                : null;
                const reviewerRouting = reviewContext?.reviewer_routing && typeof reviewContext.reviewer_routing === 'object' && !Array.isArray(reviewContext.reviewer_routing)
                    ? reviewContext.reviewer_routing as Record<string, unknown>
                    : null;
                const reviewPhaseSequenceForKey = reviewPhaseSequenceByKey.get(key) ?? null;
                const provenanceCycleFloorSequence = compilePassSequence == null
                    ? reviewPhaseSequenceForKey
                    : reviewPhaseSequenceForKey == null
                        ? compilePassSequence
                        : Math.max(compilePassSequence, reviewPhaseSequenceForKey);
                const recordEvent = reviewRecordedEventByKey.get(key) ?? null;
                const routingEvent = findLatestTimelineEvent(events, (entry) => (
                    entry.event_type === 'REVIEWER_DELEGATION_ROUTED' &&
                    String(entry.details?.review_type || entry.details?.reviewType || '').toLowerCase() === key.toLowerCase()
            ));
            if (!reviewContext || !reviewerRouting) {
                result.violations.push(
                    `Required review '${key}' is missing a valid review-context artifact with reviewer_routing metadata.`
                );
            } else {
                const resolvedRoutingIdentity = resolveReviewContextRoutingIdentity({
                    reviewerRouting,
                    canonicalSourceOfTruth,
                    executionProvider: sourceOfTruth,
                    allowLegacyCompatibility: allowLegacyReviewContextIdentityFallback
                });
                const reviewContextCanonicalSourceOfTruth = resolvedRoutingIdentity.canonical_source_of_truth;
                const reviewContextExecutionProvider = resolvedRoutingIdentity.execution_provider;
                const reviewContextExecutionProviderSource = normalizeRuntimeIdentitySource(reviewerRouting.execution_provider_source);
                const reviewContextIdentityStatus = resolvedRoutingIdentity.identity_status;
                const actualExecutionMode = normalizeCompatibilityReviewerExecutionMode(reviewerRouting.actual_execution_mode);
                const reviewerSessionId = normalizeTimelineDetailString(reviewerRouting.reviewer_session_id);
                const fallbackReason = normalizeTimelineDetailString(reviewerRouting.fallback_reason);
                if (!canonicalSourceOfTruth) {
                    result.violations.push(
                        `Required review '${key}' cannot be validated because the active workspace is missing canonical SourceOfTruth.`
                    );
                } else if (!reviewContextCanonicalSourceOfTruth) {
                    result.violations.push(
                        `Required review '${key}' review-context is missing canonical_source_of_truth.`
                    );
                } else if (reviewContextCanonicalSourceOfTruth !== canonicalSourceOfTruth) {
                    result.violations.push(
                        `Required review '${key}' review-context canonical_source_of_truth (${reviewContextCanonicalSourceOfTruth}) ` +
                        `does not match canonical provider (${canonicalSourceOfTruth}).`
                    );
                }
                if (!sourceOfTruth) {
                    result.violations.push(
                        `Required review '${key}' cannot be validated because the active task is missing execution provider identity.`
                    );
                } else if (!reviewContextExecutionProvider) {
                    result.violations.push(
                        `Required review '${key}' review-context is missing execution_provider.`
                    );
                } else if (reviewContextExecutionProvider !== sourceOfTruth) {
                    result.violations.push(
                        `Required review '${key}' review-context execution_provider (${reviewContextExecutionProvider}) ` +
                        `does not match active runtime provider (${sourceOfTruth}).`
                    );
                }
                if (resolvedRoutingIdentity.explicit_split_identity_present && !reviewContextExecutionProviderSource) {
                    result.violations.push(
                        `Required review '${key}' review-context is missing execution_provider_source.`
                    );
                } else if (
                    resolvedRoutingIdentity.explicit_split_identity_present
                    && executionProviderSource
                    && reviewContextExecutionProviderSource !== executionProviderSource
                ) {
                    result.violations.push(
                        `Required review '${key}' review-context execution_provider_source (${reviewContextExecutionProviderSource}) ` +
                        `does not match active runtime source (${executionProviderSource}).`
                    );
                }
                if (!reviewContextIdentityStatus) {
                    result.violations.push(
                        `Required review '${key}' review-context is missing identity_status.`
                    );
                } else if (reviewContextIdentityStatus !== 'resolved') {
                    result.violations.push(
                        `Required review '${key}' review-context runtime identity status must be 'resolved', got '${reviewContextIdentityStatus}'.`
                    );
                }
                if (reviewerRouting.actual_execution_mode && !actualExecutionMode) {
                    result.violations.push(
                        `Required review '${key}' has invalid reviewer_routing.actual_execution_mode ` +
                        `('${String(reviewerRouting.actual_execution_mode)}') in review-context.`
                    );
                } else if (!actualExecutionMode && artifact.receipt?.reused_existing_review !== true) {
                    result.violations.push(`Required review '${key}' is missing reviewer_routing.actual_execution_mode in review-context.`);
                } else {
                    if (actualExecutionMode && !result.reviewer_execution_modes.includes(actualExecutionMode)) {
                        result.reviewer_execution_modes.push(actualExecutionMode);
                    }
                    if (actualExecutionMode && routingPolicy.delegation_required && actualExecutionMode !== 'delegated_subagent') {
                        result.violations.push(
                            `Required review '${key}' must use delegated_subagent for provider '${routingPolicy.source_of_truth || 'unknown'}'.`
                        );
                    }
                    if (actualExecutionMode === 'same_agent_fallback') {
                        result.violations.push(
                            `Required review '${key}' used deprecated same_agent_fallback review-context routing. ` +
                            'Record a fresh delegated_subagent reviewer for the current cycle.'
                        );
                    }
                    if (actualExecutionMode && (routingPolicy.expected_execution_mode !== 'delegated_subagent' || !routingPolicy.delegation_required)) {
                        result.violations.push(
                            `Required review '${key}' resolved non-delegated reviewer policy metadata for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                            'Mandatory reviews require delegated_subagent routing.'
                        );
                    }
                    if (actualExecutionMode && (routingPolicy.fallback_allowed || routingPolicy.fallback_reason_required)) {
                        result.violations.push(
                            `Required review '${key}' resolved stale fallback-capable reviewer policy metadata for provider '${routingPolicy.source_of_truth || 'unknown'}'.`
                        );
                    }
                    if (fallbackReason) {
                        result.violations.push(
                            `Required review '${key}' review-context includes reviewer_routing.fallback_reason, ` +
                            'but mandatory reviews now require delegated_subagent only.'
                        );
                    }
                    if (actualExecutionMode === 'delegated_subagent' && reviewerSessionId && !reviewerSessionId.startsWith('agent:')) {
                        result.violations.push(
                            `Required review '${key}' claims delegated_subagent execution but reviewer_routing.reviewer_session_id ` +
                            `must be agent-scoped (expected prefix 'agent:').`
                        );
                    }
                }
                if (!reviewerSessionId && artifact.receipt?.reused_existing_review !== true) {
                    result.violations.push(`Required review '${key}' is missing reviewer_routing.reviewer_session_id in review-context.`);
                }
                const receipt = artifact.receipt;
                if (receipt) {
                    const reusedExistingReview = receipt.reused_existing_review === true;
                    const receiptExecutionMode = normalizeCompatibilityReviewerExecutionMode(receipt.reviewer_execution_mode);
                    const receiptReviewerIdentity = normalizeTimelineDetailString(receipt.reviewer_identity);
                    const receiptFallbackReason = normalizeTimelineDetailString(receipt.reviewer_fallback_reason);
                    const receiptTrustLevel = normalizeTimelineDetailString(receipt.trust_level)?.toUpperCase() ?? null;
                    const reusedFromReviewTreeStateSha256 = normalizeTimelineDetailString(receipt.reused_from_review_tree_state_sha256);
                    const receiptReviewerProvenance = receipt.reviewer_provenance == null
                        ? null
                        : normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
                    const attestedRoutingEvent = receiptReviewerProvenance
                        ? findLatestTimelineEvent(events, (entry) => (
                            (provenanceCycleFloorSequence == null || entry.sequence > provenanceCycleFloorSequence)
                            &&
                            entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
                            && String(entry.details?.review_type || entry.details?.reviewType || '').toLowerCase() === key.toLowerCase()
                            && normalizeCompatibilityReviewerExecutionMode(entry.details?.reviewer_execution_mode ?? entry.details?.reviewerExecutionMode) === receiptExecutionMode
                            && normalizeTimelineDetailString(entry.details?.reviewer_session_id ?? entry.details?.reviewerSessionId) === receiptReviewerIdentity
                            && (receiptExecutionMode !== 'same_agent_fallback'
                                || normalizeTimelineDetailString(entry.details?.reviewer_fallback_reason ?? entry.details?.reviewerFallbackReason) === receiptFallbackReason)
                            && entry.integrity?.task_sequence === receiptReviewerProvenance.task_sequence
                            && normalizeTimelineDetailString(entry.integrity?.event_sha256) === receiptReviewerProvenance.event_sha256
                            && normalizeTimelineDetailString(entry.integrity?.prev_event_sha256) === receiptReviewerProvenance.prev_event_sha256
                        ))
                        : null;
                    const invocationAttestationEvent = receiptReviewerProvenance?.attestation_type === 'reviewer_invocation_attestation'
                        ? findLatestTimelineEvent(events, (entry) => {
                            const details = entry.details;
                            const detailsTaskId = normalizeTimelineDetailString(details?.task_id ?? details?.taskId);
                            const detailsReviewerIdentity = normalizeTimelineDetailString(
                                details?.reviewer_session_id
                                    ?? details?.reviewerSessionId
                                    ?? details?.reviewer_identity
                                    ?? details?.reviewerIdentity
                            );
                            return (
                                entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                                && (!detailsTaskId || detailsTaskId === receiptReviewerProvenance.task_id)
                                && normalizeTimelineDetailString(details?.review_type ?? details?.reviewType) === key
                                && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === receiptExecutionMode
                                && detailsReviewerIdentity === receiptReviewerIdentity
                                && normalizeTimelineDetailString(details?.review_context_sha256 ?? details?.reviewContextSha256) === receiptReviewerProvenance.review_context_sha256
                                && (!reusedExistingReview || !reusedFromReviewTreeStateSha256
                                    || normalizeTimelineDetailString(details?.review_tree_state_sha256 ?? details?.reviewTreeStateSha256) === reusedFromReviewTreeStateSha256)
                                && normalizeTimelineDetailString(details?.routing_event_sha256 ?? details?.routingEventSha256) === receiptReviewerProvenance.routing_event_sha256
                                && entry.integrity?.task_sequence === receiptReviewerProvenance.task_sequence
                                && normalizeTimelineDetailString(entry.integrity?.event_sha256) === receiptReviewerProvenance.event_sha256
                                && normalizeTimelineDetailString(entry.integrity?.prev_event_sha256) === receiptReviewerProvenance.prev_event_sha256
                            );
                        })
                        : null;
                    if (receipt.reviewer_execution_mode && !receiptExecutionMode) {
                        result.violations.push(
                            `Required review '${key}' has invalid receipt reviewer_execution_mode ` +
                            `('${String(receipt.reviewer_execution_mode)}').`
                        );
                    }
                    // T-1005: Enforce receipt field presence (not just consistency)
                    if (!receiptExecutionMode) {
                        result.violations.push(
                            `Required review '${key}' receipt is missing reviewer_execution_mode. ` +
                            'Every receipt must include reviewer_execution_mode for routing enforcement.'
                        );
                    }
                    if (!receiptReviewerIdentity) {
                        result.violations.push(
                            `Required review '${key}' receipt is missing reviewer_identity. ` +
                            'Every receipt must include reviewer_identity for routing enforcement.'
                        );
                    }
                    if (receiptExecutionMode === 'same_agent_fallback') {
                        result.violations.push(
                            `Required review '${key}' receipt used deprecated same_agent_fallback execution. ` +
                            'Record a fresh delegated_subagent review receipt for the current cycle.'
                        );
                    }
                    if (receiptFallbackReason) {
                        result.violations.push(
                            `Required review '${key}' receipt includes reviewer_fallback_reason, ` +
                            'but mandatory reviews now require delegated_subagent only.'
                        );
                    }
                    if (receipt.reviewer_provenance != null && !receiptReviewerProvenance) {
                        result.violations.push(
                            `Required review '${key}' receipt has invalid reviewer_provenance.`
                        );
                    }
                    if (reusedExistingReview) {
                        const expectedReceiptPath = normalizePath(artifact.path.replace(/\.md$/, '-receipt.json')).toLowerCase();
                        const reuseTelemetryMatch = validateReviewReuseRecordedEventMatch({
                            event: recordEvent,
                            reviewType: key,
                            receiptPath: expectedReceiptPath,
                            reviewContextSha256: receipt.review_context_sha256,
                            reviewContextReuseSha256: receipt.review_context_reuse_sha256,
                            reviewTreeStateSha256: receipt.review_tree_state_sha256,
                            reviewScopeSha256: receipt.review_scope_sha256,
                            codeScopeSha256: receipt.code_scope_sha256,
                            reviewArtifactSha256: receipt.review_artifact_sha256,
                            reusedFromReceiptPath: receipt.reused_from_receipt_path || null,
                            reusedFromReceiptSha256: receipt.reused_from_receipt_sha256 || null,
                            reusedFromReviewContextSha256: receipt.reused_from_review_context_sha256 || null,
                            reusedFromReviewContextReuseSha256: receipt.reused_from_review_context_reuse_sha256 || null,
                            reusedFromReviewTreeStateSha256: reusedFromReviewTreeStateSha256 || null,
                            reusedFromReviewScopeSha256: receipt.reused_from_review_scope_sha256 || null,
                            reusedFromCodeScopeSha256: receipt.reused_from_code_scope_sha256 || null
                        });
                        if (!recordEvent || recordEvent.details?.reused_existing_review !== true) {
                            result.violations.push(
                                `Required review '${key}' reused receipt is missing REVIEW_RECORDED reuse telemetry.`
                            );
                        } else if (!reusedFromReviewTreeStateSha256) {
                            result.violations.push(
                                `Required review '${key}' reused receipt is missing reused_from_review_tree_state_sha256.`
                            );
                        } else if (!reuseTelemetryMatch.hasIntegrity) {
                            result.violations.push(
                                `Required review '${key}' REVIEW_RECORDED reuse telemetry is missing integrity.`
                            );
                        }
                        else if (!reuseTelemetryMatch.matched) {
                            result.violations.push(
                                `Required review '${key}' REVIEW_RECORDED reuse telemetry does not match receipt reuse fields.`
                            );
                        }
                        const trustViolation = getMandatoryDelegatedReviewTrustViolation({
                            reviewKey: key,
                            trustLevel: receiptTrustLevel,
                            provenanceAttestationType: receiptReviewerProvenance?.attestation_type
                        });
                        if (trustViolation) {
                            result.violations.push(
                                trustViolation.replace(`Review receipt for '${key}'`, `Required review '${key}' receipt`)
                            );
                        }
                        if (!receiptReviewerProvenance) {
                            result.violations.push(
                                `Required review '${key}' reused receipt is missing historical reviewer_provenance.`
                            );
                        } else if (receiptReviewerProvenance.attestation_type !== 'reviewer_invocation_attestation') {
                            result.violations.push(
                                `Required review '${key}' reused receipt must preserve REVIEWER_INVOCATION_ATTESTED provenance.`
                            );
                        } else if (!invocationAttestationEvent) {
                            result.violations.push(
                                `Required review '${key}' reused receipt reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED telemetry.`
                            );
                        } else if (!findMatchingHistoricalReviewRecordedTelemetryEvent(events, {
                            repoRoot,
                            taskId: receiptReviewerProvenance.task_id,
                            reviewType: key,
                            receiptPath: receipt.reused_from_receipt_path || expectedReceiptPath,
                            reviewContextSha256: receipt.reused_from_review_context_sha256 || receiptReviewerProvenance.review_context_sha256,
                            reviewContextReuseSha256: receipt.reused_from_review_context_reuse_sha256,
                            reviewTreeStateSha256: reusedFromReviewTreeStateSha256 || null,
                            reviewScopeSha256: receipt.reused_from_review_scope_sha256,
                            codeScopeSha256: receipt.reused_from_code_scope_sha256,
                            reviewArtifactSha256: receipt.review_artifact_sha256,
                            reviewerExecutionMode: receiptExecutionMode,
                            reviewerIdentity: receiptReviewerIdentity,
                            reviewerProvenance: receiptReviewerProvenance as unknown as Record<string, unknown>,
                            maxEventSequenceExclusive: compilePassSequence,
                            verifyReceiptSnapshot: true
                        })) {
                            result.violations.push(
                                `Required review '${key}' reused receipt reviewer_provenance does not match historical REVIEW_RECORDED telemetry.`
                            );
                        }
                    }
                    if (receiptExecutionMode === 'delegated_subagent' && routingEvent && !reusedExistingReview) {
                        const provenanceRoutingEvent = attestedRoutingEvent || routingEvent;
                        if (!provenanceRoutingEvent.integrity) {
                            result.violations.push(
                                `Required review '${key}' cannot validate delegated reviewer provenance because matching REVIEWER_DELEGATION_ROUTED telemetry is missing integrity.`
                            );
                        }
                        if (receiptTrustLevel === 'LOCAL_AUDITED') {
                            result.violations.push(
                                `Required review '${key}' receipt cannot claim LOCAL_AUDITED trust for delegated_subagent execution. ` +
                                'Current local routing telemetry is asserted-only until a separate launch-attestation contract exists.'
                            );
                        }
                        const trustViolation = getMandatoryDelegatedReviewTrustViolation({
                            reviewKey: key,
                            trustLevel: receiptTrustLevel,
                            provenanceAttestationType: receiptReviewerProvenance?.attestation_type
                        });
                        if (trustViolation) {
                            result.violations.push(
                                trustViolation.replace(`Review receipt for '${key}'`, `Required review '${key}' receipt`)
                            );
                        }
                        if (!receiptReviewerProvenance) {
                            result.violations.push(
                                `Required review '${key}' receipt is missing reviewer_provenance for delegated_subagent execution.`
                            );
                        } else if (receiptReviewerProvenance.attestation_type === 'reviewer_invocation_attestation') {
                            if (!invocationAttestationEvent) {
                                result.violations.push(
                                    `Required review '${key}' receipt reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry.`
                                );
                            }
                        } else if (!attestedRoutingEvent) {
                            result.violations.push(
                                `Required review '${key}' receipt reviewer_provenance does not match any REVIEWER_DELEGATION_ROUTED telemetry event in the current cycle.`
                            );
                        } else if (provenanceRoutingEvent.integrity) {
                            const routingEventSha256 = normalizeTimelineDetailString(provenanceRoutingEvent.integrity.event_sha256);
                            const routingPrevEventSha256 = normalizeTimelineDetailString(provenanceRoutingEvent.integrity.prev_event_sha256);
                            if (
                                receiptReviewerProvenance.task_sequence !== provenanceRoutingEvent.integrity.task_sequence
                                || receiptReviewerProvenance.event_sha256 !== routingEventSha256
                                || receiptReviewerProvenance.prev_event_sha256 !== routingPrevEventSha256
                            ) {
                                result.violations.push(
                                    `Required review '${key}' receipt reviewer_provenance does not match REVIEWER_DELEGATION_ROUTED telemetry integrity.`
                                );
                            }
                        }
                    }
                    // T-1005: Provider policy enforcement against receipt fields
                    if (receiptExecutionMode) {
                        if (routingPolicy.delegation_required && receiptExecutionMode !== 'delegated_subagent') {
                            result.violations.push(
                                `Required review '${key}' receipt must use delegated_subagent for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                                'Same-agent self-review is invalid for the mandatory review workflow.'
                            );
                        }
                        if (routingPolicy.expected_execution_mode !== 'delegated_subagent' || !routingPolicy.delegation_required) {
                            result.violations.push(
                                `Required review '${key}' receipt resolved non-delegated reviewer policy metadata for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                                'Mandatory reviews require delegated_subagent routing.'
                            );
                        }
                        if (routingPolicy.fallback_allowed || routingPolicy.fallback_reason_required) {
                            result.violations.push(
                                `Required review '${key}' receipt resolved stale fallback-capable reviewer policy metadata for provider '${routingPolicy.source_of_truth || 'unknown'}'.`
                            );
                        }
                    }
                    if (!reusedExistingReview && receiptExecutionMode && actualExecutionMode && receiptExecutionMode !== actualExecutionMode) {
                        result.violations.push(
                            `Required review '${key}' has inconsistent execution mode between receipt (${receiptExecutionMode}) ` +
                            `and review-context (${actualExecutionMode}).`
                        );
                    }
                    if (!reusedExistingReview && receiptReviewerIdentity && reviewerSessionId && receiptReviewerIdentity !== reviewerSessionId) {
                        result.violations.push(
                            `Required review '${key}' has inconsistent reviewer identity between receipt (${receiptReviewerIdentity}) ` +
                            `and review-context (${reviewerSessionId}).`
                        );
                    }
                    if (receiptFallbackReason && fallbackReason && receiptFallbackReason !== fallbackReason) {
                        result.violations.push(
                            `Required review '${key}' has inconsistent fallback reason between receipt and review-context.`
                        );
                    }
                }
                if (routingEvent?.details) {
                    const routingExecutionMode = normalizeCompatibilityReviewerExecutionMode(
                        routingEvent.details.reviewer_execution_mode ?? routingEvent.details.reviewerExecutionMode
                    );
                    const routingSessionId = normalizeTimelineDetailString(
                        routingEvent.details.reviewer_session_id ?? routingEvent.details.reviewerSessionId
                    );
                    if (routingExecutionMode && actualExecutionMode && routingExecutionMode !== actualExecutionMode) {
                        result.violations.push(
                            `Required review '${key}' has inconsistent execution mode between REVIEWER_DELEGATION_ROUTED telemetry ` +
                            `(${routingExecutionMode}) and review-context (${actualExecutionMode}).`
                        );
                    }
                    if (routingSessionId && reviewerSessionId && routingSessionId !== reviewerSessionId) {
                        result.violations.push(
                            `Required review '${key}' has inconsistent reviewer identity between REVIEWER_DELEGATION_ROUTED telemetry ` +
                            `(${routingSessionId}) and review-context (${reviewerSessionId}).`
                        );
                    }
                }
            }

            let artifactPath = (artifact as any).path;
            if (!artifactPath && timelinePath) {
                artifactPath = path.join(path.dirname(timelinePath.replace('task-events', 'reviews')), `${path.basename(timelinePath, '.jsonl')}-${key}.md`);
            }
            if (artifactPath && fs.existsSync(artifactPath)) {
                const content = (artifact as any).content || fs.readFileSync(artifactPath, 'utf8');
                if (isTrivialReview(content)) {
                    result.violations.push(
                        `Review artifact '${normalizePath(artifactPath)}' is trivial or obviously synthetic. ` +
                        'Meaningful review artifacts must include implementation details and carry at least 100 characters of content.'
                    );
                }
            }
        }
    }

    return result;
}
