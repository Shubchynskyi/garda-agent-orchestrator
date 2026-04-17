import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractReviewVerdictToken, type ReviewReceipt } from '../gate-runtime/review-context';
import * as gateHelpers from './helpers';
import { REVIEW_CONTRACTS, validateReviewArtifactGateEligibility } from './required-reviews-check';
import { resolveCanonicalReviewContextPath } from './review-context-paths';
import { resolveRuntimeReviewerIdentity } from './reviewer-routing';

const REVIEW_DEPENDENCY_ORDER: Readonly<Record<string, readonly string[]>> = Object.freeze({
    test: Object.freeze(['code', 'db', 'security', 'refactor', 'api', 'performance', 'infra', 'dependency'])
});

export interface ReviewDependencyTimelineEvent {
    event_type: string;
    sequence: number;
    details: Record<string, unknown> | null;
}

export interface ReviewDependencyStatus {
    reviewType: string;
    ready: boolean;
    reason: string;
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

export function getReviewDependencyTypes(reviewType: string): readonly string[] {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    return REVIEW_DEPENDENCY_ORDER[normalizedReviewType] || [];
}

export function getRequiredUpstreamReviewsFromRecord(
    reviewType: string,
    requiredReviewRecord: Record<string, boolean>
): string[] {
    return getReviewDependencyTypes(reviewType).filter((candidate) => requiredReviewRecord[candidate] === true);
}

export function getRequiredUpstreamReviews(reviewType: string, requiredReviews: unknown): string[] {
    const requiredReviewRecord = normalizeRequiredReviewRecord(requiredReviews);
    return getRequiredUpstreamReviewsFromRecord(reviewType, requiredReviewRecord);
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

export function assessUpstreamReviewDependencyStatus(options: {
    taskId: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    preflightHashSha256: string | null;
    latestRecordedReviewByType: ReadonlyMap<string, ReviewDependencyTimelineEvent>;
    upstreamReviewType: string;
    taskModePath?: string | null;
}): ReviewDependencyStatus {
    const recordedEvent = options.latestRecordedReviewByType.get(options.upstreamReviewType) ?? null;
    if (!recordedEvent) {
        return {
            reviewType: options.upstreamReviewType,
            ready: false,
            reason: 'no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'
        };
    }

    const reviewsRoot = path.dirname(options.preflightPath);
    const artifactPath = path.join(reviewsRoot, `${options.taskId}-${options.upstreamReviewType}.md`);
    let artifactBuffer: Buffer;
    try {
        artifactBuffer = fs.readFileSync(artifactPath);
    } catch {
        return {
            reviewType: options.upstreamReviewType,
            ready: false,
            reason: `missing or unreadable review artifact at ${gateHelpers.normalizePath(artifactPath)}`
        };
    }
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    let receipt: ReviewReceipt;
    try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as ReviewReceipt;
    } catch {
        return {
            reviewType: options.upstreamReviewType,
            ready: false,
            reason: `missing or invalid review receipt JSON at ${gateHelpers.normalizePath(receiptPath)}`
        };
    }
    if (receipt.task_id !== options.taskId) {
        return {
            reviewType: options.upstreamReviewType,
            ready: false,
            reason: `review receipt belongs to task '${receipt.task_id || 'unknown'}'`
        };
    }
    if (receipt.review_type !== options.upstreamReviewType) {
        return {
            reviewType: options.upstreamReviewType,
            ready: false,
            reason: `review receipt type is '${receipt.review_type || 'unknown'}'`
        };
    }
    if (
        String(receipt.preflight_sha256 || '').trim().toLowerCase()
        !== String(options.preflightHashSha256 || '').trim().toLowerCase()
    ) {
        return {
            reviewType: options.upstreamReviewType,
            ready: false,
            reason: 'review receipt is not bound to the current preflight artifact'
        };
    }

    const artifactContent = artifactBuffer.toString('utf8');
    const artifactHash = createHash('sha256').update(artifactBuffer).digest('hex').trim().toLowerCase();
    if (String(receipt.review_artifact_sha256 || '').trim().toLowerCase() !== artifactHash) {
        return {
            reviewType: options.upstreamReviewType,
            ready: false,
            reason: 'review artifact hash no longer matches its receipt'
        };
    }

    const passToken = REVIEW_CONTRACTS.find(([candidate]) => candidate === options.upstreamReviewType)?.[1] || null;
    const failToken = resolveReviewFailToken(options.upstreamReviewType);
    const reviewVerdict = extractReviewVerdictToken(artifactContent, passToken, failToken);
    if (!passToken || reviewVerdict !== passToken) {
        return {
            reviewType: options.upstreamReviewType,
            ready: false,
            reason: `review artifact verdict is '${reviewVerdict || 'missing'}' instead of '${passToken || 'unknown'}'`
        };
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
        return {
            reviewType: options.upstreamReviewType,
            ready: false,
            reason: `missing or invalid review-context artifact at ${gateHelpers.normalizePath(reviewContextPath)}`
        };
    }

    const repoRoot = resolveRepoRootFromPreflightPath(options.preflightPath);
    const runtimeIdentity = resolveRuntimeReviewerIdentity({
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
        allowLegacyReviewContextIdentityFallback: runtimeIdentity.task_mode_identity_backfilled
    });
    if (validation.violations.length > 0) {
        return {
            reviewType: options.upstreamReviewType,
            ready: false,
            reason: validation.violations.join('; ')
        };
    }

    return {
        reviewType: options.upstreamReviewType,
        ready: true,
        reason: 'pass'
    };
}

export function assertRequiredUpstreamReviewDependencies(options: {
    taskId: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    reviewType: string;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    taskModePath?: string | null;
}): void {
    const upstreamReviewTypes = getRequiredUpstreamReviews(options.reviewType, options.preflightPayload.required_reviews);
    if (upstreamReviewTypes.length === 0) {
        return;
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
        taskModePath: String(options.taskModePath || '').trim()
    }));
    const blockedDependencies = dependencyStatuses.filter((status) => !status.ready);
    if (blockedDependencies.length === 0) {
        return;
    }

    const dependencyList = blockedDependencies.map((status) => status.reviewType).join(', ');
    const detailList = blockedDependencies
        .map((status) => `${status.reviewType}: ${status.reason}`)
        .join('; ');
    throw new Error(
        `ReviewType '${options.reviewType}' is blocked until upstream reviews pass for the current cycle: ${dependencyList}. ` +
        `Run and record those reviews first. Details: ${detailList}.`
    );
}
