import {
    computeReviewLaunchPlan,
    getReviewExecutionDependencies,
    type EffectiveReviewExecutionPolicyMode,
    type ReviewLaunchPlan
} from '../core/review-execution-policy';
import {
    type FullSuiteValidationPlacement
} from '../core/workflow-config';
import {
    type GateOutcome
} from './task-audit-summary-collectors';

export interface ReviewLaunchPlannerState {
    reviewType: string;
    ready: boolean;
    failed: boolean;
    artifactExists: boolean;
    verdictToken: string | null;
    failToken: string | null;
    violations: string[];
}

export interface NextStepBlockedReviewLaneSummary {
    review_type: string;
    blocked_by: string[];
    reason: string;
}

export function buildNextStepReviewLaunchPlan(params: {
    requiredReviewTypes: string[];
    policyMode: EffectiveReviewExecutionPolicyMode;
    requiredReviews: Record<string, boolean>;
    reviewStates: ReviewLaunchPlannerState[];
    isSatisfied: (state: ReviewLaunchPlannerState) => boolean;
    isCurrentFailed: (state: ReviewLaunchPlannerState) => boolean;
}): ReviewLaunchPlan {
    const passedReviews = new Set(
        params.reviewStates
            .filter((state) => params.isSatisfied(state))
            .map((state) => state.reviewType)
    );
    return computeReviewLaunchPlan({
        requiredReviewTypes: params.requiredReviewTypes,
        requiredReviews: params.requiredReviews,
        policyMode: params.policyMode,
        reviewStates: params.reviewStates.map((state) => ({
            review_type: state.reviewType,
            satisfied: passedReviews.has(state.reviewType),
            failed_current: state.failed && params.isCurrentFailed(state)
        }))
    });
}

export function applyFullSuiteReadinessToReviewLaunchPlan(
    launchPlan: ReviewLaunchPlan,
    fullSuiteEnabled: boolean,
    fullSuitePlacement: FullSuiteValidationPlacement,
    fullSuiteNotRequiredForDocsOnly: boolean,
    fullSuiteGateStatus: GateOutcome['status'] | null
): ReviewLaunchPlan {
    if (
        !fullSuiteEnabled
        || fullSuitePlacement !== 'before_test_review'
        || fullSuiteNotRequiredForDocsOnly
        || fullSuiteGateStatus === 'PASS'
        || launchPlan.failed_review_type
        || !launchPlan.launchable_review_types.includes('test')
    ) {
        return launchPlan;
    }

    const launchableReviewTypes = launchPlan.launchable_review_types.filter((reviewType) => reviewType !== 'test');
    const blockedReviewLanes = [
        ...launchPlan.blocked_review_lanes.filter((lane) => lane.review_type !== 'test'),
        { review_type: 'test', blocked_by: ['full-suite-validation'] }
    ];
    const [nextLaunchableReviewType] = launchableReviewTypes;

    return {
        ...launchPlan,
        launchable_review_types: launchableReviewTypes,
        blocked_review_lanes: blockedReviewLanes,
        next_review_type: nextLaunchableReviewType || 'test',
        blocked_review_dependencies: nextLaunchableReviewType
            ? []
            : ['full-suite-validation']
    };
}

export function shouldRunFullSuiteAfterCompileBeforeReviews(
    enabled: boolean,
    placement: FullSuiteValidationPlacement,
    fullSuiteNotRequiredForCurrentScope: boolean
): boolean {
    return enabled
        && placement === 'after_compile_before_reviews'
        && !fullSuiteNotRequiredForCurrentScope;
}

export function shouldRunFullSuiteBeforeTestReview(
    enabled: boolean,
    placement: FullSuiteValidationPlacement,
    fullSuiteNotRequiredForCurrentScope: boolean
): boolean {
    return enabled
        && placement === 'before_test_review'
        && !fullSuiteNotRequiredForCurrentScope;
}

export function toNextStepBlockedReviewLanes(launchPlan: ReviewLaunchPlan): NextStepBlockedReviewLaneSummary[] {
    return launchPlan.blocked_review_lanes.map((lane) => ({
        review_type: lane.review_type,
        blocked_by: lane.blocked_by,
        reason: lane.blocked_by.includes('full-suite-validation')
            ? 'Waiting for current full-suite validation evidence before launching test review.'
            : lane.blocked_by.length > 0
            ? `Waiting for current-cycle ${lane.blocked_by.join(', ')} review artifacts and receipts to pass.`
            : 'Waiting for review launch dependencies to clear.'
    }));
}

export function getDownstreamReviewTypesFor(
    failedReviewType: string,
    requiredReviewTypes: string[],
    requiredReviews: Record<string, boolean>,
    policyMode: EffectiveReviewExecutionPolicyMode
): string[] {
    return requiredReviewTypes.filter((reviewType) => (
        reviewType !== failedReviewType
        && getReviewExecutionDependencies(reviewType, requiredReviews, policyMode).includes(failedReviewType)
    ));
}

export function describeBlockedReviewDependencies(
    dependencies: readonly string[],
    reviewStates: readonly ReviewLaunchPlannerState[]
): string {
    const stateByType = new Map(reviewStates.map((state) => [state.reviewType, state]));
    return dependencies
        .map((dependency) => {
            const dependencyState = stateByType.get(dependency);
            if (dependencyState?.failed) {
                return `${dependency} failed with '${dependencyState.verdictToken || dependencyState.failToken || 'FAILED'}'`;
            }
            if (dependencyState?.artifactExists && !dependencyState.ready) {
                return `${dependency} is not PASS-ready (${dependencyState.violations.join('; ')})`;
            }
            return `${dependency} has no current PASS artifact and receipt`;
        })
        .join('; ');
}
