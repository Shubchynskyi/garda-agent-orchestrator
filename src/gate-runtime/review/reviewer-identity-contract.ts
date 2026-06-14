export const PLANNED_REVIEWER_IDENTITY_PREFIX = 'agent:pending:';

export const DELEGATED_REVIEWER_IDENTITY_FROM_PROVIDER_PLACEHOLDER =
    '<agent:resolved-provider-reviewer-id-from-delegated-agent>';

export function buildPlannedReviewerIdentity(taskId: string, reviewType: string): string {
    const safeTaskId = String(taskId || '').trim();
    const safeReviewType = String(reviewType || '').trim().toLowerCase();
    return `${PLANNED_REVIEWER_IDENTITY_PREFIX}${safeTaskId}-${safeReviewType}`;
}

export function isPlannedReviewerIdentity(reviewerIdentity: string): boolean {
    return String(reviewerIdentity || '').trim().startsWith(PLANNED_REVIEWER_IDENTITY_PREFIX);
}

export function isResolvedReviewerIdentity(reviewerIdentity: string): boolean {
    const normalized = String(reviewerIdentity || '').trim();
    return normalized.startsWith('agent:') && !isPlannedReviewerIdentity(normalized);
}

export function resolveLaunchBindingReviewerIdentity(options: {
    taskId: string;
    reviewType: string;
    artifactReviewerIdentity: string;
    plannedReviewerIdentity?: string | null;
}): string {
    const plannedReviewerIdentity = String(options.plannedReviewerIdentity || '').trim()
        || buildPlannedReviewerIdentity(options.taskId, options.reviewType);
    if (isPlannedReviewerIdentity(options.artifactReviewerIdentity)) {
        return options.artifactReviewerIdentity;
    }
    if (
        options.artifactReviewerIdentity === plannedReviewerIdentity
        || isResolvedReviewerIdentity(options.artifactReviewerIdentity)
    ) {
        return plannedReviewerIdentity;
    }
    return options.artifactReviewerIdentity;
}

export function reviewerIdentityMatchesDelegatedLaunchCycle(options: {
    observedIdentity: string;
    expectedIdentity: string;
    taskId: string;
    reviewType: string;
    plannedReviewerIdentity?: string | null;
    artifactPlannedReviewerIdentity?: string | null;
    artifactResolvedReviewerIdentity?: string | null;
}): boolean {
    const observedIdentity = String(options.observedIdentity || '').trim();
    const expectedIdentity = String(options.expectedIdentity || '').trim();
    if (!observedIdentity || !expectedIdentity) {
        return false;
    }
    if (observedIdentity === expectedIdentity) {
        return true;
    }
    const plannedReviewerIdentity = String(options.plannedReviewerIdentity || '').trim()
        || buildPlannedReviewerIdentity(options.taskId, options.reviewType);
    const artifactPlannedReviewerIdentity = String(options.artifactPlannedReviewerIdentity || '').trim()
        || plannedReviewerIdentity;
    if (artifactPlannedReviewerIdentity !== plannedReviewerIdentity) {
        return false;
    }
    const artifactResolvedReviewerIdentity = String(options.artifactResolvedReviewerIdentity || '').trim();
    if (isResolvedReviewerIdentity(artifactResolvedReviewerIdentity)) {
        if (observedIdentity === plannedReviewerIdentity && expectedIdentity === artifactResolvedReviewerIdentity) {
            return true;
        }
        if (expectedIdentity === plannedReviewerIdentity && observedIdentity === artifactResolvedReviewerIdentity) {
            return true;
        }
        return false;
    }
    if (observedIdentity === plannedReviewerIdentity && isResolvedReviewerIdentity(expectedIdentity)) {
        return true;
    }
    if (expectedIdentity === plannedReviewerIdentity && isResolvedReviewerIdentity(observedIdentity)) {
        return true;
    }
    return false;
}
