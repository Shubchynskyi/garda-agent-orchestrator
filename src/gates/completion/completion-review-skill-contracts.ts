export const REVIEW_CONTRACTS = [
    ['code', 'REVIEW PASSED'],
    ['db', 'DB REVIEW PASSED'],
    ['security', 'SECURITY REVIEW PASSED'],
    ['refactor', 'REFACTOR REVIEW PASSED'],
    ['api', 'API REVIEW PASSED'],
    ['test', 'TEST REVIEW PASSED'],
    ['performance', 'PERFORMANCE REVIEW PASSED'],
    ['infra', 'INFRA REVIEW PASSED'],
    ['dependency', 'DEPENDENCY REVIEW PASSED']
] as const;

export type ReviewContractKey = typeof REVIEW_CONTRACTS[number][0];

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

