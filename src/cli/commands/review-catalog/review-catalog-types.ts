import type { ReviewDependencyGraphDeclaration } from '../../../core/review-dependency-graph';
import type { NormalizedReviewCatalog } from '../../../core/review-catalog';
import type { ReviewCapabilitiesConfigMap } from '../../../core/review-capabilities';
import type { ReviewCatalogMigrationParity } from '../../../core/review-catalog-migration';
import type { ProfilesData } from '../../../policy/profile-resolver';

export type ReviewCatalogMutationOperation =
    | 'create'
    | 'update'
    | 'enable'
    | 'disable'
    | 'profile-bind'
    | 'dependency';

export type ReviewCatalogProfileState = 'disabled' | 'auto' | 'required';

export interface ReviewCatalogRawDefinition {
    id: string;
    display_label: string;
    enabled_by_default: false;
    skill_id: string;
    trigger: {
        mode: 'manual' | 'signals';
        signal_ids: string[];
    };
    coverage_category_ids: string[];
    reviewer_role: {
        role_id: string;
        focus_tags: string[];
    };
}

export interface ReviewCatalogConfigFile {
    version: 1;
    custom_review_types: ReviewCatalogRawDefinition[];
}

export interface ReviewCatalogCommandRoots {
    repoRoot: string;
    bundleRoot: string;
    configDir: string;
    catalogPath: string;
    capabilitiesPath: string;
    profilesPath: string;
    workflowConfigPath: string;
}

export interface ReviewCatalogManagedState {
    roots: ReviewCatalogCommandRoots;
    knownSkillIds: readonly string[];
    catalogExists: boolean;
    capabilitiesExists: boolean;
    catalogConfig: ReviewCatalogConfigFile;
    catalog: NormalizedReviewCatalog;
    capabilitiesConfig: ReviewCapabilitiesConfigMap;
    capabilities: ReviewCapabilitiesConfigMap;
    profiles: ProfilesData;
    fileTexts: Readonly<Record<string, string | null>>;
    stateSha256: string;
}

export interface ReviewCatalogMutationRequest {
    operation: ReviewCatalogMutationOperation;
    reviewId: string;
    displayLabel?: string;
    skillId?: string;
    triggerMode?: 'manual' | 'signals';
    signalIds?: readonly string[];
    coverageCategoryIds?: readonly string[];
    roleId?: string;
    focusTags?: readonly string[];
    profileName?: string;
    profileState?: ReviewCatalogProfileState;
    dependencyIds?: readonly string[];
    clearDependencies?: boolean;
}

export interface ReviewCatalogSemanticDiffEntry {
    path: string;
    before: unknown;
    after: unknown;
}

export interface ReviewCatalogManagedFileChange {
    path: string;
    relative_path: string;
    before_text: string | null;
    after_text: string;
}

export interface ReviewCatalogManagementPlan {
    action: 'review-catalog-mutation' | string;
    operation: ReviewCatalogMutationOperation | string;
    review_id?: string;
    before_state_sha256: string;
    after_state_sha256: string;
    plan_sha256: string;
    changed: boolean;
    changes: ReviewCatalogManagedFileChange[];
    diff: ReviewCatalogSemanticDiffEntry[];
    explanation: string[];
    proposed_catalog?: ReviewCatalogConfigFile;
    proposed_capabilities?: ReviewCapabilitiesConfigMap;
    proposed_profiles?: ProfilesData;
    migration_parity?: ReviewCatalogMigrationParity;
}

export interface ReviewCatalogInspectionLaneSummary {
    id: string;
    display_label: string;
    built_in: boolean;
    capability_enabled: boolean;
    skill_ids: readonly string[];
    trigger: NormalizedReviewCatalog['review_types'][number]['trigger'];
    coverage_category_ids: readonly string[];
    reviewer_role: NormalizedReviewCatalog['review_types'][number]['reviewer_role'];
    verdict_tokens: NormalizedReviewCatalog['review_types'][number]['verdict_tokens'];
}

export interface ReviewCatalogInspectionLane extends ReviewCatalogInspectionLaneSummary {
    profile_states: Readonly<Record<string, ReviewCatalogProfileState>>;
    dependencies: Readonly<Record<string, readonly string[]>>;
}

export interface ReviewCatalogTransactionResult {
    status: 'APPLIED' | 'NO_CHANGE';
    audit_path: string;
    backup_path: string | null;
    protected_manifest_path: string;
}

export type MutableProfileWithGraph = ProfilesData['built_in_profiles'][string] & {
    review_dependency_graph?: ReviewDependencyGraphDeclaration;
};
