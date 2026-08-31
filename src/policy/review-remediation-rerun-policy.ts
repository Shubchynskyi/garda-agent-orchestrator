import {
    getReviewExecutionDependencies,
    getReviewExecutionPreparationOrder,
    type EffectiveReviewExecutionPolicyMode
} from '../core/review-execution-policy';
import {
    resolveReviewDependencyDownstreamReachability,
    type CompiledReviewDependencyGraph
} from '../core/review-dependency-graph';
import { REVIEW_CAPABILITY_KEYS, type ReviewCapabilityKey } from '../core/review-capabilities';
import { isPlainRecord } from '../core/records';

export const REVIEW_REMEDIATION_DELTA_CATEGORIES = Object.freeze([
    'leaf_test',
    'structural_test',
    'shared_test_helper_or_harness',
    'production',
    'global',
    'generated_churn',
    'ambiguous'
] as const);

export type ReviewRemediationDeltaCategory = typeof REVIEW_REMEDIATION_DELTA_CATEGORIES[number];

export const REVIEW_REMEDIATION_RERUN_STRATEGIES = Object.freeze([
    'current_review_only',
    'affected_dependent_reviews'
] as const);

export type ReviewRemediationRerunStrategy = typeof REVIEW_REMEDIATION_RERUN_STRATEGIES[number];
export const REVIEW_REMEDIATION_ALL_REQUIRED_LANES = 'all_required' as const;

export interface ReviewRemediationRerunRule {
    strategy: ReviewRemediationRerunStrategy;
    ordered_rerun_lanes?: ReviewCapabilityKey[] | typeof REVIEW_REMEDIATION_ALL_REQUIRED_LANES;
}

export interface ReviewRemediationRerunPolicy {
    schema_version: 1;
    policy_id: 'baseline_bound_remediation_rerun_v1';
    rules: Record<ReviewRemediationDeltaCategory, ReviewRemediationRerunRule>;
}

export interface ReviewRemediationRerunPolicyResolution {
    policy: ReviewRemediationRerunPolicy;
    diagnostics: string[];
    legacy_fallback: boolean;
}

export interface ReviewRemediationRerunDependencyEdge {
    review_type: string;
    depends_on: string[];
}

export interface ReviewRemediationRerunSelection {
    category: ReviewRemediationDeltaCategory;
    strategy: ReviewRemediationRerunStrategy;
    current_review_type: string;
    ordered_rerun_lanes: string[];
    dependency_edges: ReviewRemediationRerunDependencyEdge[];
    omitted_configured_lanes: string[];
    fallback_to_all_required: boolean;
    reason: string;
}

const POLICY_KEYS = ['schema_version', 'policy_id', 'rules'] as const;
const RULE_KEYS = ['strategy', 'ordered_rerun_lanes'] as const;
const CURRENT_REVIEW_ONLY_RULE_KEYS = ['strategy'] as const;
const LEGACY_FALLBACK_DIAGNOSTIC =
    'Legacy task profile policy snapshot missing review_remediation_rerun_policy; resolved fail-closed to affected_dependent_reviews for all required lanes.';

const DEFAULT_POLICY: ReviewRemediationRerunPolicy = {
    schema_version: 1,
    policy_id: 'baseline_bound_remediation_rerun_v1',
    rules: {
        leaf_test: { strategy: 'current_review_only' },
        structural_test: {
            strategy: 'affected_dependent_reviews',
            ordered_rerun_lanes: ['refactor', 'test']
        },
        shared_test_helper_or_harness: {
            strategy: 'affected_dependent_reviews',
            ordered_rerun_lanes: ['code', 'refactor', 'test']
        },
        production: { strategy: 'current_review_only' },
        global: {
            strategy: 'affected_dependent_reviews',
            ordered_rerun_lanes: REVIEW_REMEDIATION_ALL_REQUIRED_LANES
        },
        generated_churn: {
            strategy: 'affected_dependent_reviews',
            ordered_rerun_lanes: REVIEW_REMEDIATION_ALL_REQUIRED_LANES
        },
        ambiguous: {
            strategy: 'affected_dependent_reviews',
            ordered_rerun_lanes: REVIEW_REMEDIATION_ALL_REQUIRED_LANES
        }
    }
};

function cloneRule(rule: ReviewRemediationRerunRule): ReviewRemediationRerunRule {
    return {
        strategy: rule.strategy,
        ...(Array.isArray(rule.ordered_rerun_lanes)
            ? { ordered_rerun_lanes: [...rule.ordered_rerun_lanes] }
            : rule.ordered_rerun_lanes
                ? { ordered_rerun_lanes: rule.ordered_rerun_lanes }
                : {})
    };
}

export function cloneReviewRemediationRerunPolicy(
    policy: ReviewRemediationRerunPolicy
): ReviewRemediationRerunPolicy {
    return {
        schema_version: policy.schema_version,
        policy_id: policy.policy_id,
        rules: Object.fromEntries(
            REVIEW_REMEDIATION_DELTA_CATEGORIES.map((category) => [
                category,
                cloneRule(policy.rules[category])
            ])
        ) as ReviewRemediationRerunPolicy['rules']
    };
}

export function buildDefaultReviewRemediationRerunPolicy(): ReviewRemediationRerunPolicy {
    return cloneReviewRemediationRerunPolicy(DEFAULT_POLICY);
}

function buildLegacyFallbackPolicy(): ReviewRemediationRerunPolicy {
    const policy = buildDefaultReviewRemediationRerunPolicy();
    for (const category of REVIEW_REMEDIATION_DELTA_CATEGORIES) {
        policy.rules[category] = {
            strategy: 'affected_dependent_reviews',
            ordered_rerun_lanes: REVIEW_REMEDIATION_ALL_REQUIRED_LANES
        };
    }
    return policy;
}

function validateExactKeys(
    value: Record<string, unknown>,
    expectedKeys: readonly string[],
    label: string,
    violations: string[]
): void {
    for (const expectedKey of expectedKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, expectedKey)) {
            violations.push(`${label}.${expectedKey} is required.`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!expectedKeys.includes(key)) {
            violations.push(`${label}.${key} is not allowed.`);
        }
    }
}

export function getReviewRemediationRerunPolicyViolations(value: unknown): string[] {
    const violations: string[] = [];
    if (!isPlainRecord(value)) {
        return ['review_remediation_rerun_policy must be a JSON object.'];
    }
    validateExactKeys(value, POLICY_KEYS, 'review_remediation_rerun_policy', violations);
    if (value.schema_version !== 1) {
        violations.push('review_remediation_rerun_policy.schema_version must be 1.');
    }
    if (value.policy_id !== 'baseline_bound_remediation_rerun_v1') {
        violations.push(
            'review_remediation_rerun_policy.policy_id must be "baseline_bound_remediation_rerun_v1".'
        );
    }
    if (!isPlainRecord(value.rules)) {
        violations.push('review_remediation_rerun_policy.rules must be a JSON object.');
        return violations;
    }
    validateExactKeys(
        value.rules,
        REVIEW_REMEDIATION_DELTA_CATEGORIES,
        'review_remediation_rerun_policy.rules',
        violations
    );
    for (const category of REVIEW_REMEDIATION_DELTA_CATEGORIES) {
        const rule = value.rules[category];
        const label = `review_remediation_rerun_policy.rules.${category}`;
        if (!isPlainRecord(rule)) {
            violations.push(`${label} must be a JSON object.`);
            continue;
        }
        const strategy = String(rule.strategy || '').trim();
        if (!REVIEW_REMEDIATION_RERUN_STRATEGIES.includes(strategy as ReviewRemediationRerunStrategy)) {
            violations.push(
                `${label}.strategy must be one of ${REVIEW_REMEDIATION_RERUN_STRATEGIES.join(', ')}.`
            );
            continue;
        }
        if (rule.strategy !== strategy) {
            violations.push(`${label}.strategy must use the canonical value '${strategy}'.`);
            continue;
        }
        if (strategy === 'current_review_only') {
            validateExactKeys(rule, CURRENT_REVIEW_ONLY_RULE_KEYS, label, violations);
            continue;
        }
        validateExactKeys(rule, RULE_KEYS, label, violations);
        const configuredLanes = rule.ordered_rerun_lanes;
        if (configuredLanes === REVIEW_REMEDIATION_ALL_REQUIRED_LANES) {
            continue;
        }
        if (!Array.isArray(configuredLanes) || configuredLanes.length === 0) {
            violations.push(`${label}.ordered_rerun_lanes must be "all_required" or a non-empty array.`);
            continue;
        }
        const seen = new Set<string>();
        for (const lane of configuredLanes) {
            const normalizedLane = String(lane || '').trim().toLowerCase();
            if (!(REVIEW_CAPABILITY_KEYS as readonly string[]).includes(normalizedLane)) {
                violations.push(`${label}.ordered_rerun_lanes contains unsupported lane '${String(lane)}'.`);
            }
            if (lane !== normalizedLane) {
                violations.push(
                    `${label}.ordered_rerun_lanes lane '${String(lane)}' must use canonical value '${normalizedLane}'.`
                );
            }
            if (seen.has(normalizedLane)) {
                violations.push(`${label}.ordered_rerun_lanes contains duplicate lane '${normalizedLane}'.`);
            }
            seen.add(normalizedLane);
        }
    }
    return violations;
}

export function validateReviewRemediationRerunPolicy(value: unknown): ReviewRemediationRerunPolicy {
    const violations = getReviewRemediationRerunPolicyViolations(value);
    if (violations.length > 0) {
        throw new Error(`Review remediation rerun policy is invalid: ${violations.join(' ')}`);
    }
    return cloneReviewRemediationRerunPolicy(value as ReviewRemediationRerunPolicy);
}

export function resolveReviewRemediationRerunPolicyFromSnapshot(
    snapshot: unknown
): ReviewRemediationRerunPolicyResolution {
    if (!isPlainRecord(snapshot) || snapshot.review_remediation_rerun_policy === undefined) {
        return {
            policy: buildLegacyFallbackPolicy(),
            diagnostics: [LEGACY_FALLBACK_DIAGNOSTIC],
            legacy_fallback: true
        };
    }
    const diagnostics = Array.isArray(snapshot.review_remediation_rerun_policy_diagnostics)
        ? snapshot.review_remediation_rerun_policy_diagnostics.map((entry) => String(entry))
        : [];
    return {
        policy: validateReviewRemediationRerunPolicy(snapshot.review_remediation_rerun_policy),
        diagnostics,
        legacy_fallback: false
    };
}

function normalizeRequiredReviewTypes(
    requiredReviews: Record<string, boolean>,
    dependencyGraph?: CompiledReviewDependencyGraph | null
): string[] {
    const normalizedRequiredReviewTypes = Object.entries(requiredReviews)
        .filter(([, required]) => required === true)
        .map(([reviewType]) => String(reviewType).trim().toLowerCase())
        .filter(Boolean);
    if (dependencyGraph) {
        const requiredSet = new Set(normalizedRequiredReviewTypes);
        const missingFromGraph = normalizedRequiredReviewTypes.filter((reviewType) => !dependencyGraph.nodes.includes(reviewType));
        if (missingFromGraph.length > 0) {
            throw new Error(
                `Required remediation rerun lanes are missing from the frozen dependency graph: ${missingFromGraph.join(', ')}.`
            );
        }
        return dependencyGraph.preparation_order.filter((reviewType) => requiredSet.has(reviewType));
    }
    const canonicalOrder = getReviewExecutionPreparationOrder('strict_sequential');
    return normalizedRequiredReviewTypes
        .sort((left, right) => {
            const leftRank = canonicalOrder.indexOf(left);
            const rightRank = canonicalOrder.indexOf(right);
            const normalizedLeftRank = leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank;
            const normalizedRightRank = rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank;
            return normalizedLeftRank === normalizedRightRank
                ? left.localeCompare(right)
                : normalizedLeftRank - normalizedRightRank;
        });
}

export function resolveReviewRemediationRerunLanes(options: {
    policy: ReviewRemediationRerunPolicy;
    category: ReviewRemediationDeltaCategory;
    currentReviewType: string;
    requiredReviews: Record<string, boolean>;
    reviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode;
    reviewDependencyGraph?: CompiledReviewDependencyGraph | null;
}): ReviewRemediationRerunSelection {
    const policy = validateReviewRemediationRerunPolicy(options.policy);
    if (!REVIEW_REMEDIATION_DELTA_CATEGORIES.includes(options.category)) {
        throw new Error(`Unknown review remediation delta category '${String(options.category)}'.`);
    }
    const requiredReviewTypes = normalizeRequiredReviewTypes(
        options.requiredReviews,
        options.reviewDependencyGraph
    );
    if (requiredReviewTypes.length === 0) {
        throw new Error('Review remediation rerun policy requires at least one currently required review lane.');
    }
    const currentReviewType = String(options.currentReviewType || '').trim().toLowerCase();
    if (!currentReviewType) {
        throw new Error('Review remediation rerun policy requires the baseline review type.');
    }
    const rule = policy.rules[options.category];
    let orderedRerunLanes: string[];
    let omittedConfiguredLanes: string[] = [];
    let fallbackToAllRequired = false;
    if (rule.strategy === 'current_review_only') {
        if (requiredReviewTypes.includes(currentReviewType)) {
            orderedRerunLanes = [currentReviewType];
        } else {
            orderedRerunLanes = requiredReviewTypes;
            fallbackToAllRequired = true;
        }
    } else if (rule.ordered_rerun_lanes === REVIEW_REMEDIATION_ALL_REQUIRED_LANES) {
        orderedRerunLanes = requiredReviewTypes;
    } else {
        const configuredLanes = rule.ordered_rerun_lanes || [];
        orderedRerunLanes = configuredLanes.filter((reviewType) => requiredReviewTypes.includes(reviewType));
        omittedConfiguredLanes = configuredLanes.filter((reviewType) => !requiredReviewTypes.includes(reviewType));
        if (orderedRerunLanes.length === 0) {
            orderedRerunLanes = requiredReviewTypes;
            fallbackToAllRequired = true;
        }
    }
    if (options.reviewDependencyGraph && orderedRerunLanes.length < requiredReviewTypes.length) {
        const requiredSet = new Set(requiredReviewTypes);
        orderedRerunLanes = resolveReviewDependencyDownstreamReachability(
            options.reviewDependencyGraph,
            orderedRerunLanes
        ).affected_review_ids.filter((reviewType) => requiredSet.has(reviewType));
    }
    const selectedReviewRecord = Object.fromEntries(
        orderedRerunLanes.map((reviewType) => [reviewType, true])
    );
    const dependencyEdges = orderedRerunLanes.map((reviewType) => ({
        review_type: reviewType,
        depends_on: getReviewExecutionDependencies(
            reviewType,
            selectedReviewRecord,
            options.reviewExecutionPolicyMode,
            options.reviewDependencyGraph
        ).filter((dependency) => orderedRerunLanes.includes(dependency))
    }));
    return {
        category: options.category,
        strategy: rule.strategy,
        current_review_type: currentReviewType,
        ordered_rerun_lanes: orderedRerunLanes,
        dependency_edges: dependencyEdges,
        omitted_configured_lanes: omittedConfiguredLanes,
        fallback_to_all_required: fallbackToAllRequired,
        reason: fallbackToAllRequired
            ? `configured ${rule.strategy} lanes were unavailable; expanded to every currently required review lane`
            : omittedConfiguredLanes.length > 0
                ? `selected configured affected lanes; omitted non-required lanes: ${omittedConfiguredLanes.join(', ')}`
                : rule.strategy === 'current_review_only'
                    ? options.reviewDependencyGraph && orderedRerunLanes.length > 1
                        ? `remediation starts at '${currentReviewType}' and expands through affected downstream graph lanes`
                        : `leaf remediation remains on current review '${currentReviewType}'`
                    : rule.ordered_rerun_lanes === REVIEW_REMEDIATION_ALL_REQUIRED_LANES
                        ? 'broad or uncertain remediation expands to every currently required review lane'
                        : 'selected the configured affected dependent review lanes'
    };
}
