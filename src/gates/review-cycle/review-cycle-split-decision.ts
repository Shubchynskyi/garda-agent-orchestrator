import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    fileSha256,
    isPathRealpathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';

export const REVIEW_CYCLE_SPLIT_DECISIONS = ['split_task', 'create_follow_up_tasks'] as const;
export const REVIEW_CYCLE_SPLIT_DECISION_EVENT = 'REVIEW_CYCLE_SPLIT_DECISION_RECORDED';
export const REVIEW_CYCLE_SPLIT_DECISION_ARTIFACT_SUFFIX = '-review-cycle-split-decision.json';

export type ReviewCycleSplitDecision = typeof REVIEW_CYCLE_SPLIT_DECISIONS[number];

export interface ReviewCycleSplitDecisionArtifact {
    schema_version: 1;
    event_source: 'record-review-cycle-split-decision';
    task_id: string;
    status: 'SPLIT_REQUIRED';
    scope: 'task';
    decision: ReviewCycleSplitDecision;
    reason: string;
    recorded_at_utc: string;
    operator_confirmed: true;
    operator_confirmed_at_utc: string;
    preflight_path: string;
    preflight_sha256: string;
    baseline: {
        total_non_test_review_count: number;
        failed_non_test_review_count: number;
        max_total_non_test_reviews: number;
        max_failed_non_test_reviews: number;
        excluded_review_types: string[];
    };
    next_actions: string[];
}

export function normalizeReviewCycleSplitDecision(value: unknown): ReviewCycleSplitDecision {
    const normalized = typeof value === 'string'
        ? value.trim().toLowerCase().replace(/[\s-]+/g, '_')
        : '';
    if (!REVIEW_CYCLE_SPLIT_DECISIONS.includes(normalized as ReviewCycleSplitDecision)) {
        throw new Error(`--decision must be one of: ${REVIEW_CYCLE_SPLIT_DECISIONS.join(', ')}.`);
    }
    return normalized as ReviewCycleSplitDecision;
}

export function resolveReviewCycleSplitDecisionArtifactPath(
    repoRoot: string,
    taskId: string,
    artifactPath = ''
): string {
    const trimmed = String(artifactPath || '').trim();
    if (trimmed) {
        const reviewEvidenceRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
        const resolved = resolvePathInsideRepo(trimmed, repoRoot, {
            allowMissing: true,
            enforceInside: true
        });
        if (!resolved) {
            throw new Error('ArtifactPath must resolve inside the repository.');
        }
        if (!isPathRealpathInsideRoot(resolved, reviewEvidenceRoot, { allowMissing: true })) {
            throw new Error(
                `ArtifactPath must stay inside the runtime review evidence directory after realpath resolution: ${normalizePath(resolved)}`
            );
        }
        return resolved;
    }
    return joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}${REVIEW_CYCLE_SPLIT_DECISION_ARTIFACT_SUFFIX}`)
    );
}

export function buildReviewCycleSplitDecisionArtifact(params: {
    taskId: string;
    decision: unknown;
    reason: string;
    operatorConfirmedAtUtc: string;
    preflightPath: string;
    baselineTotalNonTestReviewCount: number;
    baselineFailedNonTestReviewCount: number;
    maxTotalNonTestReviews: number;
    maxFailedNonTestReviews: number;
    excludedReviewTypes: string[];
    recordedAtUtc?: string;
}): ReviewCycleSplitDecisionArtifact {
    const reason = String(params.reason || '').trim();
    if (!reason) {
        throw new Error('Reason is required.');
    }
    const preflightPath = normalizePath(params.preflightPath);
    const preflightSha256 = fileSha256(params.preflightPath) || '';
    if (!preflightSha256) {
        throw new Error(`PreflightPath is required and must be readable: ${preflightPath}`);
    }
    return {
        schema_version: 1,
        event_source: 'record-review-cycle-split-decision',
        task_id: params.taskId,
        status: 'SPLIT_REQUIRED',
        scope: 'task',
        decision: normalizeReviewCycleSplitDecision(params.decision),
        reason,
        recorded_at_utc: params.recordedAtUtc || new Date().toISOString(),
        operator_confirmed: true,
        operator_confirmed_at_utc: params.operatorConfirmedAtUtc,
        preflight_path: preflightPath,
        preflight_sha256: preflightSha256,
        baseline: {
            total_non_test_review_count: params.baselineTotalNonTestReviewCount,
            failed_non_test_review_count: params.baselineFailedNonTestReviewCount,
            max_total_non_test_reviews: params.maxTotalNonTestReviews,
            max_failed_non_test_reviews: params.maxFailedNonTestReviews,
            excluded_review_types: [...params.excludedReviewTypes]
        },
        next_actions: [
            'keep_parent_split_required',
            'create_and_link_child_tasks',
            'rerun_next_step_on_parent_to_transition_to_decomposed'
        ]
    };
}

export function resolveReviewCycleSplitDecisionPreflightPath(repoRoot: string, rawPreflightPath: unknown): string {
    const requestedPath = String(rawPreflightPath || '').trim();
    if (!requestedPath) {
        throw new Error('--preflight-path is required.');
    }
    const resolved = resolvePathInsideRepo(requestedPath, repoRoot, {
        allowMissing: false,
        enforceInside: true
    });
    if (!resolved || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`--preflight-path must resolve to an existing file inside the repository: ${requestedPath}`);
    }
    return resolved;
}
