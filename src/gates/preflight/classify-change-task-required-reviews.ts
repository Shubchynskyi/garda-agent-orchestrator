import {
    REVIEW_CAPABILITY_KEYS,
    type ReviewCapabilities,
    type ReviewCapabilityKey
} from '../../core/review-capabilities';

export interface TaskRequiredReviewDeclaration {
    source: 'task_queue_notes';
    declared_reviews: ReviewCapabilityKey[];
    applied_reviews: ReviewCapabilityKey[];
}

export interface ResolveTaskRequiredReviewDeclarationOptions {
    taskId: string;
    notes: string | null | undefined;
    reviewCapabilities: Partial<ReviewCapabilities>;
}

const REQUIRED_REVIEWS_SENTENCE_START = /(^|[.!?]\s+)(required\s+reviews\b)/gi;
const REQUIRED_REVIEWS_DECLARATION = /^required\s+reviews\s*:\s*([^.!?]*)(?:[.!?]|$)/i;
const REVIEW_LANE_TOKEN = /^[a-z][a-z0-9_-]*$/i;

function formatAllowedReviewLanes(): string {
    return REVIEW_CAPABILITY_KEYS.join(', ');
}

function invalidDeclaration(taskId: string, reason: string): Error {
    return new Error(
        `Task '${taskId}' has invalid TASK.md required-review declaration: ${reason} `
        + `Allowed lanes: ${formatAllowedReviewLanes()}.`
    );
}

export function resolveTaskRequiredReviewDeclaration(
    options: ResolveTaskRequiredReviewDeclarationOptions
): TaskRequiredReviewDeclaration | null {
    const notes = String(options.notes || '').trim();
    if (!notes) {
        return null;
    }

    const sentenceStarts = [...notes.matchAll(REQUIRED_REVIEWS_SENTENCE_START)];
    if (sentenceStarts.length === 0) {
        return null;
    }
    if (sentenceStarts.length > 1) {
        throw invalidDeclaration(options.taskId, 'multiple "Required reviews" declarations were found.');
    }

    const sentenceStart = sentenceStarts[0];
    const boundary = sentenceStart[1] || '';
    const markerOffset = (sentenceStart.index || 0) + boundary.length;
    const declarationMatch = REQUIRED_REVIEWS_DECLARATION.exec(notes.slice(markerOffset));
    if (!declarationMatch) {
        throw invalidDeclaration(
            options.taskId,
            'expected the exact form "Required reviews: lane, lane.".'
        );
    }

    const rawLaneList = declarationMatch[1].trim();
    if (!rawLaneList) {
        throw invalidDeclaration(options.taskId, 'the lane list is empty.');
    }

    const rawLanes = rawLaneList.split(',').map((lane) => lane.trim());
    if (rawLanes.some((lane) => !lane || !REVIEW_LANE_TOKEN.test(lane))) {
        throw invalidDeclaration(options.taskId, 'lanes must be non-empty comma-separated identifiers.');
    }

    const declaredReviews = rawLanes.map((lane) => lane.toLowerCase());
    const duplicateLane = declaredReviews.find((lane, index) => declaredReviews.indexOf(lane) !== index);
    if (duplicateLane) {
        throw invalidDeclaration(options.taskId, `lane '${duplicateLane}' is declared more than once.`);
    }

    const unknownLane = declaredReviews.find((lane) => !REVIEW_CAPABILITY_KEYS.includes(lane as ReviewCapabilityKey));
    if (unknownLane) {
        throw invalidDeclaration(options.taskId, `unknown lane '${unknownLane}'.`);
    }

    const typedReviews = declaredReviews as ReviewCapabilityKey[];
    const unavailableLane = typedReviews.find((lane) => options.reviewCapabilities[lane] !== true);
    if (unavailableLane) {
        throw new Error(
            `Task '${options.taskId}' required-review declaration cannot be honored: review lane '${unavailableLane}' `
            + `is unavailable because review-capabilities.${unavailableLane} is not enabled.`
        );
    }

    return {
        source: 'task_queue_notes',
        declared_reviews: [...typedReviews],
        applied_reviews: [...typedReviews]
    };
}

export function applyTaskRequiredReviewDeclaration(
    requiredReviews: Record<string, boolean>,
    declaration: TaskRequiredReviewDeclaration | null
): void {
    for (const reviewType of declaration?.applied_reviews || []) {
        requiredReviews[reviewType] = true;
    }
}
