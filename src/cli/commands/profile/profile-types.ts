export type ParsedOptionsRecord = Record<string, string | boolean | string[] | undefined>;

export type MaybePromise<T> = T | Promise<T>;

export interface ProfileEntry {
    description: string;
    depth: number;
    review_policy: Record<string, boolean | 'auto'>;
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
