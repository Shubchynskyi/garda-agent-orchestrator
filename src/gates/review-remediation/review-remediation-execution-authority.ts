import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import type {
    ReviewRemediationReviewContract,
    ReviewRemediationReviewContractValidationAuthority
} from './review-remediation-review-contract';
import type { ReviewRemediationDecisionClassification } from './review-remediation-recovery-routing';

export function resolvePersistedRemediationReviewExecutionAuthority(options: {
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    preflightSha256: string;
    fullReviewScope: readonly string[];
    reviewExecution: ReviewRemediationReviewContract;
}): ReviewRemediationReviewContractValidationAuthority | null {
    if (options.reviewExecution.source === 'initial_full') {
        return null;
    }
    const timelinePath = path.join(
        path.dirname(options.reviewsRoot),
        'task-events',
        `${options.taskId}.jsonl`
    );
    const events: Readonly<Record<string, unknown>>[] = [];
    const inspection = inspectTaskEventFile(timelinePath, options.taskId, {
        onIntegrityEvent: (event) => events.push(event)
    });
    if (!inspection.status.startsWith('PASS')) {
        return null;
    }
    const normalizedPreflightSha256 = options.preflightSha256.trim().toLowerCase();
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const details = isPlainRecord(event.details) ? event.details : null;
        if (
            event.event_type !== 'REVIEW_CYCLE_RESTARTED'
            || !details
            || details.task_id !== options.taskId
            || details.event_type !== 'REVIEW_CYCLE_RESTARTED'
            || details.status !== 'PASSED'
            || String(details.preflight_sha256 || '').trim().toLowerCase() !== normalizedPreflightSha256
            || !isPlainRecord(details.authoritative_review_decision)
            || !isPlainRecord(details.authoritative_review_classification)
        ) {
            continue;
        }
        const decision = details.authoritative_review_decision;
        const classification = details.authoritative_review_classification as unknown as ReviewRemediationDecisionClassification;
        const lane = Array.isArray(decision.lane_decisions)
            ? decision.lane_decisions.find((value) => (
                isPlainRecord(value) && value.review_type === options.reviewType
            ))
            : null;
        if (
            !isPlainRecord(lane)
            || lane.mode !== options.reviewExecution.mode
            || decision.preflight_sha256 !== normalizedPreflightSha256
        ) {
            return null;
        }
        return {
            taskId: options.taskId,
            reviewType: options.reviewType,
            preflightSha256: normalizedPreflightSha256,
            mode: options.reviewExecution.mode,
            fullReviewScope: options.fullReviewScope,
            persistedDecisionSha256: String(decision.decision_sha256 || '').trim().toLowerCase(),
            authoritativeDecisionSha256: String(decision.decision_sha256 || '').trim().toLowerCase(),
            authoritativeClassificationSha256: String(decision.classification_sha256 || '').trim().toLowerCase(),
            authoritativeDecision: decision as unknown as ReviewRemediationReviewContractValidationAuthority['authoritativeDecision'],
            authoritativeClassification: classification
        };
    }
    return null;
}
