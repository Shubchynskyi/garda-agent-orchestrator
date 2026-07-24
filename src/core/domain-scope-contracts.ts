export const DOMAIN_SCOPE_NAMES = ['implementation', 'test', 'docs', 'config', 'closeout'] as const;

export type DomainScopeName = typeof DOMAIN_SCOPE_NAMES[number];

export interface DomainScopeFingerprintEntry {
    changed_files: string[];
    changed_files_count: number;
    changed_files_sha256: string | null;
    scope_content_sha256: string | null;
    scope_sha256: string | null;
}

export interface DomainScopeFingerprints {
    schema_version: 1;
    detection_source: string;
    include_untracked: boolean;
    use_staged: boolean;
    domains: Record<DomainScopeName, DomainScopeFingerprintEntry>;
    legacy: {
        review_scope_sha256: string | null;
        code_scope_sha256: string | null;
        non_test_review_scope_sha256?: string | null;
        code_review_scope_sha256?: string | null;
    };
}
