import * as path from 'node:path';
import * as childProcess from 'node:child_process';

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
    performance_support_changed_files: string[];
    missing_non_test_files: string[];
    code_scope_sha256: string | null;
    test_only: boolean;
    docs_only: boolean;
}

export interface ReviewRelevantScopeFingerprint {
    all_changed_files: string[];
    review_relevant_changed_files: string[];
    docs_only_changed_files: string[];
    missing_review_relevant_files: string[];
    review_scope_sha256: string | null;
    docs_only: boolean;
}

export function isNonTestReviewScope(reviewType: string): boolean {
    return String(reviewType || '').trim().toLowerCase() !== 'test';
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
            sha256: String(entry.content_sha256 || entry.sha256 || entry.hash || '').trim() || null
        }));
}

function toBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'true') {
        return true;
    }
    if (normalized === 'false') {
        return false;
    }
    return null;
}

function toNumberOrNull(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function toLowerHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function toNormalizedPathList(value: unknown): string[] {
    return toStringList(value)
        .map((entry) => normalizePath(entry))
        .filter(Boolean)
        .sort();
}

function buildScopedDiffReuseMetadata(value: unknown): Record<string, unknown> {
    const metadata = toRecord(value);
    if (Object.keys(metadata).length === 0) {
        return {};
    }
    const hunkFilter = toRecord(metadata.hunk_filter);
    return {
        review_type: String(metadata.review_type || '').trim().toLowerCase() || null,
        detection_source: String(metadata.detection_source || '').trim().toLowerCase() || null,
        changed_files: toNormalizedPathList(metadata.changed_files),
        matched_files: toNormalizedPathList(metadata.matched_files),
        changed_files_sha256: toLowerHash(metadata.changed_files_sha256),
        scope_content_sha256: toLowerHash(metadata.scope_content_sha256),
        scope_sha256: toLowerHash(metadata.scope_sha256),
        use_staged: toBoolean(metadata.use_staged),
        include_untracked: toBoolean(metadata.include_untracked),
        untracked_files: toNormalizedPathList(metadata.untracked_files),
        untracked_diff_truncated: toBoolean(metadata.untracked_diff_truncated),
        full_diff_source: String(metadata.full_diff_source || '').trim() || null,
        fallback_to_full_diff: toBoolean(metadata.fallback_to_full_diff),
        output_diff_sha256: toLowerHash(metadata.output_diff_sha256),
        scoped_diff_line_count: toNumberOrNull(metadata.scoped_diff_line_count),
        output_diff_line_count: toNumberOrNull(metadata.output_diff_line_count),
        hunk_level: toBoolean(metadata.hunk_level),
        hunk_filter: Object.keys(hunkFilter).length > 0
            ? {
                total_file_blocks: toNumberOrNull(hunkFilter.total_file_blocks),
                included_file_blocks: toNumberOrNull(hunkFilter.included_file_blocks),
                total_hunks: toNumberOrNull(hunkFilter.total_hunks),
                included_hunks: toNumberOrNull(hunkFilter.included_hunks),
                hunk_level_filtered: toBoolean(hunkFilter.hunk_level_filtered)
            }
            : null,
        parse_error: String(metadata.parse_error || '').trim() || null
    };
}

function getDetectionSource(preflight: Record<string, unknown>): string {
    return String(preflight.detection_source || '').trim().toLowerCase();
}

function pathStartsWithConfiguredRoot(filePath: string, roots: readonly string[]): boolean {
    const normalizedPath = normalizePath(filePath);
    return roots.some((rootValue) => {
        const root = normalizePath(rootValue).replace(/^\/+/, '').replace(/\/+$/, '');
        return !!root && (normalizedPath === root || normalizedPath.startsWith(`${root}/`));
    });
}

function hasPerformanceSupportDirectory(filePath: string): boolean {
    const segments = normalizePath(filePath).split('/').filter(Boolean);
    const supportDirectories = new Set(['benchmark', 'benchmarks', 'perf', 'performance']);
    const supportParents = new Set(['scripts', 'tools', 'tooling']);
    if (segments.length >= 2 && supportDirectories.has(segments[0])) {
        return true;
    }
    return segments.length >= 3
        && supportParents.has(segments[0])
        && supportDirectories.has(segments[1]);
}

function isNonRuntimePerformanceSupportPath(
    filePath: string,
    classificationConfig: ReturnType<typeof getClassificationConfig>
): boolean {
    const normalizedPath = normalizePath(filePath);
    if (!hasPerformanceSupportDirectory(normalizedPath)) {
        return false;
    }
    if (pathStartsWithConfiguredRoot(normalizedPath, classificationConfig.runtime_roots)) {
        return false;
    }
    return matchAnyRegex(normalizedPath, classificationConfig.performance_trigger_regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
}

function usesStagedContent(preflight: Record<string, unknown>): boolean {
    const detectionSource = getDetectionSource(preflight);
    return detectionSource === 'git_staged_only' || detectionSource === 'git_staged_plus_untracked';
}

function getStagedBlobFingerprint(repoRoot: string, relativePath: string): string | null {
    try {
        const result = childProcess.spawnSync('git', ['ls-files', '-s', '--', `:(literal)${relativePath}`], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            timeout: 30_000
        });
        if (result.status !== 0) {
            return null;
        }
        const firstLine = String(result.stdout || '').split(/\r?\n/).find((line) => line.trim());
        if (!firstLine) {
            return null;
        }
        const match = /^(\d+)\s+([0-9a-f]{40,64})\s+\d+\t/.exec(firstLine);
        if (!match || !match[1] || !match[2]) {
            return null;
        }
        return `staged:${match[1]}:${match[2].toLowerCase()}`;
    } catch {
        return null;
    }
}

function getScopedContentFingerprint(
    repoRoot: string,
    preflight: Record<string, unknown>,
    relativePath: string
): { fingerprint: string | null; missing: boolean } {
    if (usesStagedContent(preflight)) {
        const stagedFingerprint = getStagedBlobFingerprint(repoRoot, relativePath);
        if (stagedFingerprint) {
            return { fingerprint: stagedFingerprint, missing: false };
        }
        if (getDetectionSource(preflight) === 'git_staged_only') {
            return { fingerprint: null, missing: true };
        }
    }
    const absolutePath = path.resolve(repoRoot, relativePath);
    const hash = fileSha256(absolutePath);
    return {
        fingerprint: hash ? `worktree:${hash}` : null,
        missing: !hash
    };
}

function computeCodeReviewScopeFingerprintInternal(
    preflight: Record<string, unknown>,
    repoRoot: string,
    options: { excludeNonRuntimePerformanceSupportFiles?: boolean } = {}
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
    const performanceSupportChangedFiles = allChangedFiles.filter((filePath) => (
        isNonRuntimePerformanceSupportPath(filePath, classificationConfig)
    ));
    const performanceSupportSet = new Set(
        options.excludeNonRuntimePerformanceSupportFiles ? performanceSupportChangedFiles : []
    );
    const nonTestChangedFiles = allChangedFiles.filter((filePath) => (
        !testChangedFiles.includes(filePath)
        && !docsOnlyChangedFiles.includes(filePath)
        && !performanceSupportSet.has(filePath)
    ));
    const sortedNonTestFiles = [...nonTestChangedFiles].sort();
    const missingNonTestFiles: string[] = [];
    const fingerprintEntries = sortedNonTestFiles.map((relativePath) => {
        const scopedFingerprint = getScopedContentFingerprint(repoRoot, preflight, relativePath);
        if (scopedFingerprint.missing) {
            missingNonTestFiles.push(relativePath);
        }
        return `${relativePath}:${scopedFingerprint.fingerprint || 'MISSING'}`;
    });

    return {
        all_changed_files: allChangedFiles,
        non_test_changed_files: sortedNonTestFiles,
        docs_only_changed_files: [...docsOnlyChangedFiles].sort(),
        performance_support_changed_files: [...performanceSupportChangedFiles].sort(),
        missing_non_test_files: missingNonTestFiles,
        code_scope_sha256: stringSha256(fingerprintEntries.join('\n')),
        test_only: sortedNonTestFiles.length === 0 && testChangedFiles.length === allChangedFiles.length,
        docs_only: sortedNonTestFiles.length === 0 && docsOnlyChangedFiles.length === allChangedFiles.length
    };
}

export function computeCodeReviewScopeFingerprint(
    preflight: Record<string, unknown>,
    repoRoot: string
): CodeReviewScopeFingerprint {
    return computeCodeReviewScopeFingerprintInternal(preflight, repoRoot);
}

export function computeReviewReuseCodeScopeFingerprint(
    reviewType: string,
    preflight: Record<string, unknown>,
    repoRoot: string
): CodeReviewScopeFingerprint {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    return computeCodeReviewScopeFingerprintInternal(preflight, repoRoot, {
        excludeNonRuntimePerformanceSupportFiles: normalizedReviewType === 'code'
    });
}

export function computeReviewRelevantScopeFingerprint(
    preflight: Record<string, unknown>,
    repoRoot: string
): ReviewRelevantScopeFingerprint {
    const classificationConfig = getClassificationConfig(repoRoot);
    const allChangedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const docsOnlyChangedFiles = allChangedFiles.filter((filePath) => (
        isDocumentationLikePath(filePath)
        && !isRuntimeCodeLikePath(filePath, classificationConfig.code_like_regexes, classificationConfig.runtime_roots)
    ));
    const docsOnlySet = new Set(docsOnlyChangedFiles);
    const reviewRelevantFiles = allChangedFiles.filter((filePath) => !docsOnlySet.has(filePath));
    const sortedReviewRelevantFiles = [...reviewRelevantFiles].sort();
    const missingReviewRelevantFiles: string[] = [];
    const fingerprintEntries = sortedReviewRelevantFiles.map((relativePath) => {
        const scopedFingerprint = getScopedContentFingerprint(repoRoot, preflight, relativePath);
        if (scopedFingerprint.missing) {
            missingReviewRelevantFiles.push(relativePath);
        }
        return `${relativePath}:${scopedFingerprint.fingerprint || 'MISSING'}`;
    });

    return {
        all_changed_files: allChangedFiles,
        review_relevant_changed_files: sortedReviewRelevantFiles,
        docs_only_changed_files: [...docsOnlyChangedFiles].sort(),
        missing_review_relevant_files: missingReviewRelevantFiles,
        review_scope_sha256: stringSha256(fingerprintEntries.join('\n')),
        docs_only: sortedReviewRelevantFiles.length === 0 && docsOnlyChangedFiles.length === allChangedFiles.length
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
            source_file_count: typeof ruleContext.source_file_count === 'number' ? ruleContext.source_file_count : null,
            strip_examples_applied: ruleContext.strip_examples_applied === true,
            strip_code_blocks_applied: ruleContext.strip_code_blocks_applied === true,
            source_files: toSourceFileSummary(ruleContext.source_files)
        },
        scoped_diff: {
            expected: scopedDiff.expected === true,
            metadata: buildScopedDiffReuseMetadata(scopedDiff.metadata)
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
