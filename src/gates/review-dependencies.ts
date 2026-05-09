import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskEventIntegrity } from '../gate-runtime/task-events';
import { extractReviewVerdictToken, type ReviewReceipt } from '../gate-runtime/review-context';
import {
    DEFAULT_REVIEW_EXECUTION_POLICY_MODE,
    getReviewExecutionDependencies,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode
} from '../core/review-execution-policy';
import * as gateHelpers from './helpers';
import { REVIEW_CONTRACTS, validateReviewArtifactGateEligibility } from './required-reviews-check';
import { resolveCanonicalReviewContextPath } from './review-context-paths';
import { resolveRuntimeReviewerIdentity, type RuntimeReviewerIdentity } from './reviewer-routing';

export interface ReviewDependencyTimelineEvent {
    event_type: string;
    sequence: number;
    details: Record<string, unknown> | null;
    integrity?: TaskEventIntegrity | null;
}

export interface ReviewDependencyStatus {
    reviewType: string;
    ready: boolean;
    reason: string;
    blockerCode: ReviewDependencyBlockerCode | null;
    dependencyEdge: boolean;
}

export const REVIEW_DEPENDENCY_BLOCKER_CODES = Object.freeze([
    'no_dependency_edge',
    'missing_upstream_pass',
    'missing_receipt',
    'missing_context',
    'stale_freshness'
] as const);

export type ReviewDependencyBlockerCode = typeof REVIEW_DEPENDENCY_BLOCKER_CODES[number];

export interface ReviewDependencyDiagnostics {
    reviewType: string;
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode;
    requiredUpstreamReviews: string[];
    statuses: ReviewDependencyStatus[];
}

export function normalizeRequiredReviewRecord(value: unknown): Record<string, boolean> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    const source = value as Record<string, unknown>;
    const result: Record<string, boolean> = {};
    for (const [key, rawValue] of Object.entries(source)) {
        result[String(key).trim().toLowerCase()] = rawValue === true;
    }
    return result;
}

export function getReviewDependencyTypes(
    reviewType: string,
    requiredReviewRecord: Record<string, boolean>,
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode = DEFAULT_REVIEW_EXECUTION_POLICY_MODE
): string[] {
    return getReviewExecutionDependencies(reviewType, requiredReviewRecord, reviewExecutionPolicyMode);
}

export function getRequiredUpstreamReviewsFromRecord(
    reviewType: string,
    requiredReviewRecord: Record<string, boolean>,
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode = DEFAULT_REVIEW_EXECUTION_POLICY_MODE
): string[] {
    return getReviewDependencyTypes(reviewType, requiredReviewRecord, reviewExecutionPolicyMode);
}

export function getRequiredUpstreamReviews(
    reviewType: string,
    requiredReviews: unknown,
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode = DEFAULT_REVIEW_EXECUTION_POLICY_MODE
): string[] {
    const requiredReviewRecord = normalizeRequiredReviewRecord(requiredReviews);
    return getRequiredUpstreamReviewsFromRecord(reviewType, requiredReviewRecord, reviewExecutionPolicyMode);
}

function findLatestTimelineSequence(
    events: readonly ReviewDependencyTimelineEvent[],
    predicate: (entry: ReviewDependencyTimelineEvent) => boolean
): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) {
            return events[index].sequence;
        }
    }
    return null;
}

function resolveReviewFailToken(reviewType: string): string | null {
    const passToken = REVIEW_CONTRACTS.find(([candidate]) => candidate === reviewType)?.[1] || null;
    if (!passToken) {
        return null;
    }
    return passToken.replace(/\bPASSED\b/g, 'FAILED');
}

export function buildLatestRecordedReviewEventMap(
    events: readonly ReviewDependencyTimelineEvent[],
    latestCompilePassSequence: number | null
): Map<string, ReviewDependencyTimelineEvent> {
    const result = new Map<string, ReviewDependencyTimelineEvent>();
    if (latestCompilePassSequence == null) {
        return result;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.sequence <= latestCompilePassSequence) {
            break;
        }
        if (entry.event_type !== 'REVIEW_RECORDED') {
            continue;
        }
        const normalizedReviewType = String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase();
        if (!normalizedReviewType || result.has(normalizedReviewType)) {
            continue;
        }
        result.set(normalizedReviewType, entry);
    }
    return result;
}

function resolveReviewContextPath(
    preflightPath: string,
    reviewType: string,
    recordedReviewEvent: ReviewDependencyTimelineEvent
): string {
    const explicitPath = gateHelpers.normalizePath(
        recordedReviewEvent.details?.review_context_path ?? recordedReviewEvent.details?.reviewContextPath
    );
    const reviewsRoot = path.dirname(preflightPath);
    const taskId = path.basename(preflightPath, path.extname(preflightPath)).replace(/-preflight$/, '');
    return resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath
    });
}

function resolveRepoRootFromPreflightPath(preflightPath: string): string {
    return path.resolve(path.dirname(preflightPath), '..', '..', '..');
}

function readyDependencyStatus(reviewType: string, reason = 'pass'): ReviewDependencyStatus {
    return {
        reviewType,
        ready: true,
        reason,
        blockerCode: null,
        dependencyEdge: true
    };
}

function noDependencyEdgeStatus(reviewType: string): ReviewDependencyStatus {
    return {
        reviewType,
        ready: true,
        reason: 'no dependency edge for this review type under the current review execution policy',
        blockerCode: 'no_dependency_edge',
        dependencyEdge: false
    };
}

function blockedDependencyStatus(
    reviewType: string,
    blockerCode: Exclude<ReviewDependencyBlockerCode, 'no_dependency_edge'>,
    reason: string
): ReviewDependencyStatus {
    return {
        reviewType,
        ready: false,
        reason,
        blockerCode,
        dependencyEdge: true
    };
}

export function assessUpstreamReviewDependencyStatus(options: {
    taskId: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    preflightHashSha256: string | null;
    latestRecordedReviewByType: ReadonlyMap<string, ReviewDependencyTimelineEvent>;
    upstreamReviewType: string;
    timelineEvents?: readonly ReviewDependencyTimelineEvent[];
    taskModePath?: string | null;
    runtimeReviewerIdentity?: RuntimeReviewerIdentity | null;
}): ReviewDependencyStatus {
    const recordedEvent = options.latestRecordedReviewByType.get(options.upstreamReviewType) ?? null;
    if (!recordedEvent) {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'missing_upstream_pass',
            'no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'
        );
    }

    const reviewsRoot = path.dirname(options.preflightPath);
    const artifactPath = path.join(reviewsRoot, `${options.taskId}-${options.upstreamReviewType}.md`);
    let artifactBuffer: Buffer;
    try {
        artifactBuffer = fs.readFileSync(artifactPath);
    } catch {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'missing_upstream_pass',
            `missing or unreadable review artifact at ${gateHelpers.normalizePath(artifactPath)}`
        );
    }
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    let receipt: ReviewReceipt;
    try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as ReviewReceipt;
    } catch {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'missing_receipt',
            `missing or invalid review receipt JSON at ${gateHelpers.normalizePath(receiptPath)}`
        );
    }
    if (receipt.task_id !== options.taskId) {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'stale_freshness',
            `review receipt belongs to task '${receipt.task_id || 'unknown'}'`
        );
    }
    if (receipt.review_type !== options.upstreamReviewType) {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'stale_freshness',
            `review receipt type is '${receipt.review_type || 'unknown'}'`
        );
    }
    if (
        String(receipt.preflight_sha256 || '').trim().toLowerCase()
        !== String(options.preflightHashSha256 || '').trim().toLowerCase()
    ) {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'stale_freshness',
            'review receipt is not bound to the current preflight artifact'
        );
    }

    const artifactContent = artifactBuffer.toString('utf8');
    const artifactHash = createHash('sha256').update(artifactBuffer).digest('hex').trim().toLowerCase();
    if (String(receipt.review_artifact_sha256 || '').trim().toLowerCase() !== artifactHash) {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'stale_freshness',
            'review artifact hash no longer matches its receipt'
        );
    }

    const passToken = REVIEW_CONTRACTS.find(([candidate]) => candidate === options.upstreamReviewType)?.[1] || null;
    const failToken = resolveReviewFailToken(options.upstreamReviewType);
    const reviewVerdict = extractReviewVerdictToken(
        artifactContent,
        passToken,
        failToken,
        options.upstreamReviewType
    );
    if (failToken && reviewVerdict === failToken) {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'missing_upstream_pass',
            `upstream review failed with '${failToken}'; fix implementation and rerun compile plus ` +
            `'${options.upstreamReviewType}' review before launching dependent reviews`
        );
    }
    if (!passToken || reviewVerdict !== passToken) {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'missing_upstream_pass',
            `review artifact verdict is '${reviewVerdict || 'missing'}' instead of '${passToken || 'unknown'}'`
        );
    }

    const reviewContextPath = resolveReviewContextPath(
        options.preflightPath,
        options.upstreamReviewType,
        recordedEvent
    );
    let reviewContext: Record<string, unknown>;
    try {
        reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
    } catch {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'missing_context',
            `missing or invalid review-context artifact at ${gateHelpers.normalizePath(reviewContextPath)}`
        );
    }

    const repoRoot = resolveRepoRootFromPreflightPath(options.preflightPath);
    const runtimeIdentity = options.runtimeReviewerIdentity || resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId: options.taskId,
        taskModePath: String(options.taskModePath || '').trim(),
        allowLegacyFallback: true
    });
    const validation = validateReviewArtifactGateEligibility({
        resolvedTaskId: options.taskId,
        reviewKey: options.upstreamReviewType,
        required: true,
        skippedByOverride: false,
        preflightPath: options.preflightPath,
        preflightSha256: options.preflightHashSha256,
        preflightPayload: options.preflightPayload,
        canonicalSourceOfTruth: runtimeIdentity.canonical_source_of_truth,
        executionProvider: runtimeIdentity.execution_provider,
        executionProviderSource: runtimeIdentity.execution_provider_source,
        reviewArtifact: {
            path: artifactPath,
            content: artifactContent,
            reviewContext,
            reviewContextPath,
            reviewContextSha256: String(gateHelpers.fileSha256(reviewContextPath) || '').trim().toLowerCase() || null,
            artifactSha256: artifactHash,
            receipt
        },
        allowLegacyReviewContextIdentityFallback: runtimeIdentity.task_mode_identity_backfilled,
        timelineEvents: options.timelineEvents,
        repoRoot
    });
    if (validation.violations.length > 0) {
        return blockedDependencyStatus(
            options.upstreamReviewType,
            'stale_freshness',
            validation.violations.join('; ')
        );
    }

    return readyDependencyStatus(options.upstreamReviewType);
}

export function buildReviewDependencyDiagnostics(options: {
    taskId: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    reviewType: string;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    taskModePath?: string | null;
    runtimeReviewerIdentity?: RuntimeReviewerIdentity | null;
}): ReviewDependencyDiagnostics {
    const reviewExecutionPolicyMode = resolveReviewExecutionPolicyModeFromPreflight(options.preflightPayload);
    const upstreamReviewTypes = getRequiredUpstreamReviews(
        options.reviewType,
        options.preflightPayload.required_reviews,
        reviewExecutionPolicyMode
    );
    if (upstreamReviewTypes.length === 0) {
        return {
            reviewType: options.reviewType,
            reviewExecutionPolicyMode,
            requiredUpstreamReviews: [],
            statuses: [noDependencyEdgeStatus(options.reviewType)]
        };
    }
    const latestCompilePassSequence = findLatestTimelineSequence(
        options.timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    const latestRecordedReviewByType = buildLatestRecordedReviewEventMap(options.timelineEvents, latestCompilePassSequence);
    const currentPreflightHashSha256 = String(gateHelpers.fileSha256(options.preflightPath) || '').trim().toLowerCase() || null;
    const dependencyStatuses = upstreamReviewTypes.map((upstreamReviewType) => assessUpstreamReviewDependencyStatus({
        taskId: options.taskId,
        preflightPath: options.preflightPath,
        preflightPayload: options.preflightPayload,
        preflightHashSha256: currentPreflightHashSha256,
        latestRecordedReviewByType,
        upstreamReviewType,
        timelineEvents: options.timelineEvents,
        taskModePath: String(options.taskModePath || '').trim(),
        runtimeReviewerIdentity: options.runtimeReviewerIdentity || null
    }));
    return {
        reviewType: options.reviewType,
        reviewExecutionPolicyMode,
        requiredUpstreamReviews: upstreamReviewTypes,
        statuses: dependencyStatuses
    };
}

export function assertRequiredUpstreamReviewDependencies(options: {
    taskId: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    reviewType: string;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    taskModePath?: string | null;
    runtimeReviewerIdentity?: RuntimeReviewerIdentity | null;
}): void {
    const dependencyDiagnostics = buildReviewDependencyDiagnostics(options);
    const dependencyStatuses = dependencyDiagnostics.statuses.filter((status) => status.dependencyEdge);
    const blockedDependencies = dependencyStatuses.filter((status) => !status.ready);
    if (blockedDependencies.length === 0) {
        return;
    }

    const dependencyList = blockedDependencies.map((status) => status.reviewType).join(', ');
    const taxonomyList = blockedDependencies
        .map((status) => `${status.blockerCode || 'unknown'}=${status.reviewType}`)
        .join(', ');
    const detailList = blockedDependencies
        .map((status) => `${status.reviewType}: [${status.blockerCode || 'unknown'}] ${status.reason}`)
        .join('; ');
    throw new Error(
        `ReviewType '${options.reviewType}' is blocked until upstream reviews pass for the current cycle: ${dependencyList}. ` +
        `Run and record those reviews first. DependencyPolicy: ${dependencyDiagnostics.reviewExecutionPolicyMode}. ` +
        `BlockerTaxonomy: ${taxonomyList}. Details: ${detailList}.`
    );
}
