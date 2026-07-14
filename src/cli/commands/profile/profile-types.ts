export type ParsedOptionsRecord = Record<string, string | boolean | string[] | undefined>;

export type MaybePromise<T> = T | Promise<T>;

export interface ProfileEntry {
    description: string;
    depth: number;
    review_policy: Record<string, boolean | 'auto'>;
    review_finding_policy?: {
        schema_version: 1;
        policy_id: 'soft' | 'balanced' | 'strict' | 'custom';
        findings: {
            critical: 'fix_now' | 'create_follow_up' | 'ignore';
            high: 'fix_now' | 'create_follow_up' | 'ignore';
            medium: 'fix_now' | 'create_follow_up' | 'ignore';
            low: 'fix_now' | 'create_follow_up' | 'ignore';
        };
        residual_risk: 'fix_now' | 'create_follow_up' | 'ignore';
    };
    token_economy: Record<string, boolean>;
    skills: Record<string, boolean>;
}

export interface ProfilesData {
    version: number;
    active_profile: string;
    built_in_profiles: Record<string, ProfileEntry>;
    user_profiles: Record<string, ProfileEntry>;
}

export interface ProfileValidateResult {
    passed: boolean;
    issues: string[];
}
