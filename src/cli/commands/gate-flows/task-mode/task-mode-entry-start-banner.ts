import {
    normalizeOrchestratorStartBanner,
    ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE
} from '../../../../core/orchestrator-start-banner';

export function resolveTaskModeStartBanner(requestedStartBanner: unknown): string | null {
    const requestedBanner = String(requestedStartBanner || '').trim();
    if (requestedBanner) {
        const normalizedRequestedBanner = normalizeOrchestratorStartBanner(requestedBanner);
        if (!normalizedRequestedBanner) {
            throw new Error(
                `StartBanner must be one of the repo-owned banners (${ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE}). ` +
                `Got '${requestedBanner}'.`
            );
        }
        return normalizedRequestedBanner;
    }

    return null;
}
