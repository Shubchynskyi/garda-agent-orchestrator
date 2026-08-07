import { buildBuiltInReviewTypeDefinitions } from '../../core/review-catalog';
import { resolveEffectiveReviewLaneSetOrLegacy } from '../../policy/effective-review-lane-set';

export type ReviewContract = readonly [string, string];
export type ReviewSkillCandidatesByType = Readonly<Record<string, readonly string[]>>;

export const REVIEW_CONTRACTS: readonly ReviewContract[] = Object.freeze(
    buildBuiltInReviewTypeDefinitions().map((definition) => (
        Object.freeze([definition.id, definition.verdict_tokens.pass] as const)
    ))
);

export const REVIEW_SKILL_CANDIDATES: ReviewSkillCandidatesByType = Object.freeze(
    Object.fromEntries(buildBuiltInReviewTypeDefinitions().map((definition) => [
        definition.id,
        Object.freeze([...definition.skill_ids])
    ]))
);

export type ReviewContractKey = string;

export function resolveCompletionReviewContracts(
    preflight: Record<string, unknown> | null | undefined
): readonly ReviewContract[] {
    return Object.freeze(resolveEffectiveReviewLaneSetOrLegacy(preflight).lanes.map((lane) => (
        Object.freeze([lane.id, lane.pass_token] as const)
    )));
}

export function resolveCompletionReviewSkillCandidates(
    preflight: Record<string, unknown> | null | undefined
): ReviewSkillCandidatesByType {
    return Object.freeze(Object.fromEntries(
        resolveEffectiveReviewLaneSetOrLegacy(preflight).lanes.map((lane) => [
            lane.id,
            Object.freeze([...lane.definition.skill_ids])
        ])
    ));
}

export interface ReviewSkillEvidenceResult {
    skill_ids: string[];
    reference_paths: string[];
    artifact_keys: string[];
    reviewer_execution_modes: string[];
    violations: string[];
}

export function createEmptyReviewSkillEvidenceResult(): ReviewSkillEvidenceResult {
    return {
        skill_ids: [],
        reference_paths: [],
        artifact_keys: [],
        reviewer_execution_modes: [],
        violations: []
    };
}

export function getRequiredReviewKeys(requiredReviews: Record<string, unknown>): string[] {
    const requiredKeys: string[] = [];
    for (const [key, value] of Object.entries(requiredReviews)) {
        if (value === true) {
            requiredKeys.push(key);
        }
    }
    return requiredKeys;
}
