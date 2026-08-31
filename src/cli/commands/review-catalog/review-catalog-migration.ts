import * as path from 'node:path';

import { analyzeReviewCatalogMigrationParity } from '../../../core/review-catalog-migration';
import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig,
    type ResolvedReviewExecutionPolicyConfig
} from '../../../core/review-execution-policy';
import {
    computeReviewCatalogStateSha256,
    readReviewCatalogManagedConfigText,
    readReviewCatalogManagedState,
    serializeReviewCatalogManagedConfig,
    sha256Text,
    validateReviewCatalogCombinedConfig
} from './review-catalog-state';
import type {
    ReviewCatalogCommandRoots,
    ReviewCatalogManagedFileChange,
    ReviewCatalogManagedState,
    ReviewCatalogManagementPlan,
    ReviewCatalogSemanticDiffEntry
} from './review-catalog-types';

export interface ReviewCatalogMigrationContext {
    state: ReviewCatalogManagedState;
    reviewExecutionPolicy: ResolvedReviewExecutionPolicyConfig;
    workflowConfigText: string | null;
    migrationStateSha256: string;
}

export const REVIEW_CATALOG_MIGRATION_ACTION = 'review-catalog-migration' as const;
export const REVIEW_CATALOG_MIGRATION_OPERATION = 'migrate' as const;

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function parseWorkflowConfig(text: string | null, filePath: string): unknown {
    if (text === null) return null;
    try {
        return JSON.parse(text);
    } catch (error: unknown) {
        throw new Error(
            `workflow-config is not valid JSON at '${filePath}': `
            + `${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function computeMigrationStateSha256(
    managedStateSha256: string,
    workflowConfigText: string | null,
    reviewExecutionPolicy: ResolvedReviewExecutionPolicyConfig
): string {
    return sha256Text(JSON.stringify({
        managed_state_sha256: managedStateSha256,
        workflow_config_exists: workflowConfigText !== null,
        workflow_config_sha256: workflowConfigText === null ? null : sha256Text(workflowConfigText),
        review_execution_policy: reviewExecutionPolicy
    }));
}

export function readReviewCatalogMigrationContext(
    roots: ReviewCatalogCommandRoots
): ReviewCatalogMigrationContext {
    const state = readReviewCatalogManagedState(roots);
    const workflowConfigText = readReviewCatalogManagedConfigText(roots.workflowConfigPath, false);
    const workflowConfig = parseWorkflowConfig(workflowConfigText, roots.workflowConfigPath);
    const reviewExecutionPolicy = resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig(
        workflowConfig,
        LEGACY_REVIEW_EXECUTION_POLICY_MODE
    );
    return {
        state,
        reviewExecutionPolicy,
        workflowConfigText,
        migrationStateSha256: computeMigrationStateSha256(
            state.stateSha256,
            workflowConfigText,
            reviewExecutionPolicy
        )
    };
}

function buildNormalizedChanges(
    context: ReviewCatalogMigrationContext,
    proposedCatalog: ReviewCatalogManagedState['catalogConfig'],
    proposedCapabilities: ReviewCatalogManagedState['capabilitiesConfig'],
    proposedProfiles: ReviewCatalogManagedState['profiles']
): ReviewCatalogManagedFileChange[] {
    const state = context.state;
    const candidates = [
        { path: state.roots.catalogPath, value: proposedCatalog },
        { path: state.roots.capabilitiesPath, value: proposedCapabilities },
        { path: state.roots.profilesPath, value: proposedProfiles }
    ];
    return candidates.flatMap(({ path: filePath, value }) => {
        const beforeText = state.fileTexts[filePath] ?? null;
        const afterText = serializeReviewCatalogManagedConfig(value);
        if (beforeText === afterText) return [];
        return [{
            path: filePath,
            relative_path: path.relative(state.roots.bundleRoot, filePath).replace(/\\/gu, '/'),
            before_text: beforeText,
            after_text: afterText
        }];
    });
}

function buildMigrationDiff(
    context: ReviewCatalogMigrationContext,
    changes: readonly ReviewCatalogManagedFileChange[]
): ReviewCatalogSemanticDiffEntry[] {
    return changes.map((change) => {
        const fileName = path.basename(change.path);
        if (fileName === 'review-catalog.json' && !context.state.catalogExists) {
            return {
                path: 'review-catalog.materialization',
                before: {
                    source: 'implicit_compatibility',
                    catalog_sha256: context.state.catalog.catalog_sha256
                },
                after: {
                    source: 'explicit_config',
                    catalog_sha256: context.state.catalog.catalog_sha256
                }
            };
        }
        return {
            path: `review-catalog-migration.normalized_files.${fileName}`,
            before: change.before_text === null ? null : sha256Text(change.before_text),
            after: sha256Text(change.after_text)
        };
    });
}

export function buildReviewCatalogMigrationPlan(
    context: ReviewCatalogMigrationContext
): ReviewCatalogManagementPlan {
    const state = context.state;
    const proposedCatalog = clone(state.catalogConfig);
    const proposedCapabilities = clone(state.capabilities);
    const proposedProfiles = clone(state.profiles);
    const validated = validateReviewCatalogCombinedConfig(
        proposedCatalog,
        proposedCapabilities,
        proposedProfiles,
        state.knownSkillIds
    );
    const parity = analyzeReviewCatalogMigrationParity({
        catalogExists: state.catalogExists,
        sourceCatalogConfig: state.catalogConfig,
        proposedCatalogConfig: proposedCatalog,
        sourceCapabilities: state.capabilities,
        proposedCapabilities: validated.capabilities,
        sourceProfiles: state.profiles,
        proposedProfiles: validated.profiles,
        knownSkillIds: state.knownSkillIds,
        reviewExecutionPolicy: context.reviewExecutionPolicy
    });
    const changes = buildNormalizedChanges(
        context,
        proposedCatalog,
        validated.capabilitiesConfig,
        validated.profiles
    );
    const afterFileTexts = { ...state.fileTexts };
    for (const change of changes) afterFileTexts[change.path] = change.after_text;
    const afterManagedStateSha256 = computeReviewCatalogStateSha256(afterFileTexts);
    const afterStateSha256 = computeMigrationStateSha256(
        afterManagedStateSha256,
        context.workflowConfigText,
        context.reviewExecutionPolicy
    );
    const diff = buildMigrationDiff(context, changes);
    const explanation = [
        state.catalogExists
            ? 'The explicit review catalog already exists; migration only normalizes drifted managed JSON when needed.'
            : 'The implicit built-in compatibility catalog will be materialized explicitly.',
        `Parity PASS binds required reviews, verdicts and receipts, dependency order, and task reports to ${parity.parity_sha256}.`,
        'Legacy review-capabilities.json is retained; no custom review capability is enabled by migration.',
        `Review execution preset '${context.reviewExecutionPolicy.mode}' remains unchanged.`
    ];
    const planBody = {
        action: REVIEW_CATALOG_MIGRATION_ACTION,
        operation: REVIEW_CATALOG_MIGRATION_OPERATION,
        before_state_sha256: context.migrationStateSha256,
        after_state_sha256: afterStateSha256,
        changed: changes.length > 0,
        changes,
        diff,
        explanation,
        migration_parity: parity
    };
    return {
        ...planBody,
        plan_sha256: sha256Text(JSON.stringify(planBody)),
        proposed_catalog: proposedCatalog,
        proposed_capabilities: validated.capabilitiesConfig,
        proposed_profiles: validated.profiles
    };
}
