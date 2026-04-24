import * as path from 'node:path';

import { matchAnyRegex } from '../gate-runtime/text-utils';
import { getClassificationConfig, isDocumentationLikePath, isRuntimeCodeLikePath } from './classify-change';
import {
    fileSha256,
    normalizePath,
    stringSha256
} from './helpers';

export interface CodeReviewScopeFingerprint {
    all_changed_files: string[];
    non_test_changed_files: string[];
    docs_only_changed_files: string[];
    missing_non_test_files: string[];
    code_scope_sha256: string | null;
    test_only: boolean;
    docs_only: boolean;
}

function toRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return {};
}

function toStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function toSectionList(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => toRecord(entry))
        .filter((entry) => Object.keys(entry).length > 0)
        .map((entry) => ({
            section: String(entry.section || '').trim() || null,
            reason: String(entry.reason || '').trim() || null,
            details: String(entry.details || '').trim() || null
        }));
}

function toSourceFileSummary(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => toRecord(entry))
        .filter((entry) => Object.keys(entry).length > 0)
        .map((entry) => ({
            path: String(entry.path || entry.file || '').trim() || null,
            sha256: String(entry.sha256 || entry.hash || '').trim() || null
        }));
}

export function computeCodeReviewScopeFingerprint(
    preflight: Record<string, unknown>,
    repoRoot: string
): CodeReviewScopeFingerprint {
    const classificationConfig = getClassificationConfig(repoRoot);
    const allChangedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const testChangedFiles = allChangedFiles.filter((filePath) => matchAnyRegex(filePath, classificationConfig.test_trigger_regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    }));
    const docsOnlyChangedFiles = allChangedFiles.filter((filePath) => (
        isDocumentationLikePath(filePath)
        && !isRuntimeCodeLikePath(filePath, classificationConfig.code_like_regexes, classificationConfig.runtime_roots)
    ));
    const nonTestChangedFiles = allChangedFiles.filter((filePath) => (
        !testChangedFiles.includes(filePath)
        && !docsOnlyChangedFiles.includes(filePath)
    ));
    const sortedNonTestFiles = [...nonTestChangedFiles].sort();
    const missingNonTestFiles: string[] = [];
    const fingerprintEntries = sortedNonTestFiles.map((relativePath) => {
        const absolutePath = path.resolve(repoRoot, relativePath);
        const hash = fileSha256(absolutePath);
        if (!hash) {
            missingNonTestFiles.push(relativePath);
        }
        return `${relativePath}:${hash || 'MISSING'}`;
    });

    return {
        all_changed_files: allChangedFiles,
        non_test_changed_files: sortedNonTestFiles,
        docs_only_changed_files: [...docsOnlyChangedFiles].sort(),
        missing_non_test_files: missingNonTestFiles,
        code_scope_sha256: stringSha256(fingerprintEntries.join('\n')),
        test_only: sortedNonTestFiles.length === 0 && testChangedFiles.length === allChangedFiles.length,
        docs_only: sortedNonTestFiles.length === 0 && docsOnlyChangedFiles.length === allChangedFiles.length
    };
}

export function computeReviewContextReuseHash(reviewContext: Record<string, unknown>): string | null {
    if (!reviewContext || typeof reviewContext !== 'object' || Array.isArray(reviewContext)) {
        return null;
    }

    const rulePack = toRecord(reviewContext.rule_pack);
    const tokenEconomy = toRecord(reviewContext.token_economy);
    const ruleContext = toRecord(reviewContext.rule_context);
    const scopedDiff = toRecord(reviewContext.scoped_diff);
    const reviewerRouting = toRecord(reviewContext.reviewer_routing);
    const plan = toRecord(reviewContext.plan);

    const snapshot = {
        schema_version: typeof reviewContext.schema_version === 'number' ? reviewContext.schema_version : null,
        review_type: String(reviewContext.review_type || '').trim().toLowerCase() || null,
        depth: typeof reviewContext.depth === 'number' ? reviewContext.depth : null,
        token_economy_active: reviewContext.token_economy_active === true,
        required_review: reviewContext.required_review === true,
        rule_pack: {
            selected_rule_files: toStringList(rulePack.selected_rule_files),
            omitted_rule_files: toStringList(rulePack.omitted_rule_files),
            omission_reason: String(rulePack.omission_reason || '').trim() || null
        },
        token_economy: {
            active: tokenEconomy.active === true,
            flags: toRecord(tokenEconomy.flags),
            omitted_sections: toSectionList(tokenEconomy.omitted_sections),
            omission_reason: String(tokenEconomy.omission_reason || '').trim() || null
        },
        rule_context: {
            artifact_sha256: String(ruleContext.artifact_sha256 || '').trim().toLowerCase() || null,
            source_file_count: typeof ruleContext.source_file_count === 'number' ? ruleContext.source_file_count : null,
            strip_examples_applied: ruleContext.strip_examples_applied === true,
            strip_code_blocks_applied: ruleContext.strip_code_blocks_applied === true,
            summary: toRecord(ruleContext.summary),
            source_files: toSourceFileSummary(ruleContext.source_files)
        },
        scoped_diff: {
            expected: scopedDiff.expected === true,
            metadata: toRecord(scopedDiff.metadata)
        },
        reviewer_routing: {
            source_of_truth: String(reviewerRouting.source_of_truth || '').trim() || null,
            canonical_source_of_truth: String(reviewerRouting.canonical_source_of_truth || '').trim() || null,
            canonical_entrypoint: String(reviewerRouting.canonical_entrypoint || '').trim() || null,
            execution_provider: String(reviewerRouting.execution_provider || '').trim() || null,
            execution_provider_source: String(reviewerRouting.execution_provider_source || '').trim() || null,
            routed_to: String(reviewerRouting.routed_to || '').trim() || null,
            provider_bridge: String(reviewerRouting.provider_bridge || '').trim() || null,
            identity_status: String(reviewerRouting.identity_status || '').trim() || null,
            identity_violations: toStringList(reviewerRouting.identity_violations),
            capability_level: String(reviewerRouting.capability_level || '').trim() || null,
            delegation_required: reviewerRouting.delegation_required === true,
            expected_execution_mode: String(reviewerRouting.expected_execution_mode || '').trim() || null,
            fallback_allowed: reviewerRouting.fallback_allowed !== false,
            fallback_reason_required: reviewerRouting.fallback_reason_required === true,
            reviewer_execution_mode_required: reviewerRouting.reviewer_execution_mode_required === true,
            reviewer_identity_required: reviewerRouting.reviewer_identity_required === true,
            note: String(reviewerRouting.note || '').trim() || null
        },
        plan: {
            plan_guided: plan.plan_guided === true,
            plan_sha256: String(plan.plan_sha256 || '').trim().toLowerCase() || null,
            plan_summary: String(plan.plan_summary || '').trim() || null
        }
    };

    return stringSha256(JSON.stringify(snapshot));
}
