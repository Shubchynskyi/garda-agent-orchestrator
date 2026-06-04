import type { ReviewCapabilities } from '../../core/review-capabilities';

export interface RequiredReviewDecisionInput {
    runtimeCodeChanged: boolean;
    mode: string;
    dbTriggered: boolean;
    securityTriggered: boolean;
    refactorTriggered: boolean;
    apiTriggered: boolean;
    testTriggered: boolean;
    performanceTriggered: boolean;
    infraTriggered: boolean;
    dependencyTriggered: boolean;
    reviewCapabilities: Partial<ReviewCapabilities>;
}

export function buildRequiredReviews(input: RequiredReviewDecisionInput): Record<string, boolean> {
    return {
        code: input.runtimeCodeChanged && input.mode === 'FULL_PATH',
        db: input.dbTriggered,
        security: input.securityTriggered,
        refactor: input.refactorTriggered,
        api: input.apiTriggered && !!input.reviewCapabilities.api,
        test: input.testTriggered && !!input.reviewCapabilities.test,
        performance: input.performanceTriggered && !!input.reviewCapabilities.performance,
        infra: input.infraTriggered && !!input.reviewCapabilities.infra,
        dependency: input.dependencyTriggered && !!input.reviewCapabilities.dependency
    };
}
