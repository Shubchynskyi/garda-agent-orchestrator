import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../core/constants';
import { buildReviewContextSections } from '../gate-runtime/review-context';
import { withReviewArtifactLock, writeArtifactFileAtomically } from '../gate-runtime/review-artifacts';
import { normalizePath, orchestratorRelativePath, parseBool, resolvePathInsideRepo, toStringArray } from './helpers';
import { resolveGateExecutionPath, resolveGateExecutionPathPosix } from './isolation-sandbox';
import { readRuntimeReviewerProvider, resolveReviewerRoutingPolicy } from './reviewer-routing';
import { getTaskModeEvidence } from './task-mode';

/**
 * Rule pack configuration by review type.
 * Matches Python get_rule_pack.
 */
export function getRulePack(reviewType: string) {
    if (reviewType === 'code') {
        return {
            full: ['00-core.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md'],
            depth1: ['00-core.md', '80-task-workflow.md'],
            depth2: ['00-core.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md']
        };
    }
    if (reviewType === 'db' || reviewType === 'security') {
        return {
            full: ['00-core.md', '35-strict-coding-rules.md', '70-security.md', '80-task-workflow.md'],
            depth1: ['00-core.md', '80-task-workflow.md'],
            depth2: ['00-core.md', '35-strict-coding-rules.md', '70-security.md', '80-task-workflow.md']
        };
    }
    if (reviewType === 'refactor') {
        return {
            full: ['00-core.md', '30-code-style.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '80-task-workflow.md'],
            depth1: ['00-core.md', '80-task-workflow.md'],
            depth2: ['00-core.md', '30-code-style.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '80-task-workflow.md']
        };
    }
    return {
        full: ['00-core.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md'],
        depth1: ['00-core.md', '80-task-workflow.md'],
        depth2: ['00-core.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md']
    };
}

export function selectRulePackFiles(reviewType: string, depth: number): string[] {
    const rulePack = getRulePack(reviewType);
    if (depth >= 3) {
        return [...rulePack.full];
    }
    if (depth <= 1) {
        return [...rulePack.depth1];
    }
    return [...rulePack.depth2];
}

const REVIEW_SKILL_CANDIDATES: Record<string, string[]> = Object.freeze({
    code: ['code-review'],
    db: ['db-review'],
    security: ['security-review'],
    refactor: ['refactor-review'],
    api: ['api-review', 'api-contract-review'],
    test: ['test-review', 'testing-strategy'],
    performance: ['performance-review'],
    infra: ['infra-review'],
    dependency: ['dependency-review']
});

export function getReviewSkillCandidates(reviewType: string): string[] {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const candidates = REVIEW_SKILL_CANDIDATES[normalizedReviewType];
    if (!candidates) {
        return [`${normalizedReviewType}-review`].filter(Boolean);
    }
    return [...candidates];
}

export function resolveReviewSkillId(reviewType: string, repoRoot: string): string {
    const rulesRoot = path.resolve(repoRoot);
    for (const candidate of getReviewSkillCandidates(reviewType)) {
        const skillRoot = path.join(rulesRoot, resolveBundleName(), 'live', 'skills', candidate);
        const skillMdPath = path.join(skillRoot, 'SKILL.md');
        const skillJsonPath = path.join(skillRoot, 'skill.json');
        if (
            (fs.existsSync(skillMdPath) && fs.statSync(skillMdPath).isFile())
            || (fs.existsSync(skillJsonPath) && fs.statSync(skillJsonPath).isFile())
        ) {
            return candidate;
        }
    }
    return getReviewSkillCandidates(reviewType)[0];
}

/**
 * Resolve the output path for review context.
 */
export function resolveContextOutputPath(explicitOutputPath: string, preflightPath: string, reviewType: string, repoRoot: string): string {
    if (explicitOutputPath && explicitOutputPath.trim()) {
        return resolvePathInsideRepo(explicitOutputPath, repoRoot, { allowMissing: true }) as string;
    }
    const preflightDir = path.dirname(preflightPath);
    const baseName = path.basename(preflightPath, path.extname(preflightPath)).replace(/-preflight$/, '');
    return path.resolve(preflightDir, `${baseName}-${reviewType}-context.json`);
}

/**
 * Resolve scoped diff metadata path.
 */
export function resolveScopedDiffMetadataPath(explicitPath: string, preflightPath: string, reviewType: string, repoRoot: string): string {
    if (explicitPath && explicitPath.trim()) {
        return resolvePathInsideRepo(explicitPath, repoRoot, { allowMissing: true }) as string;
    }
    const preflightDir = path.dirname(preflightPath);
    const baseName = path.basename(preflightPath, path.extname(preflightPath)).replace(/-preflight$/, '');
    return path.resolve(preflightDir, `${baseName}-${reviewType}-scoped.json`);
}

/**
 * Convert a value to non-negative integer or null.
 */
export function toNonNegativeInt(value: unknown): number | null {
    if (value == null || typeof value === 'boolean') return null;
    if (typeof value === 'number') return value >= 0 ? Math.floor(value) : null;
    try {
        const parsed = parseInt(String(value).trim(), 10);
        return parsed >= 0 ? parsed : null;
    } catch { return null; }
}

interface TokenEconomyConfig {
    enabled?: unknown;
    enabled_depths?: unknown;
    strip_examples?: unknown;
    strip_code_blocks?: unknown;
    scoped_diffs?: unknown;
    compact_reviewer_output?: unknown;
    fail_tail_lines?: unknown;
}

export interface BuildReviewContextOptions {
    reviewType: string;
    depth: number;
    preflightPath: string;
    tokenEconomyConfigPath: string;
    scopedDiffMetadataPath: string;
    outputPath: string;
    repoRoot: string;
}

/**
 * Build review context for a specific review type and depth.
 * Builds the review-context artifact shape for the Node gate runtime.
 */
export function buildReviewContext(options: BuildReviewContextOptions) {
    const reviewType = options.reviewType;
    const depth = options.depth;
    const preflightPath = options.preflightPath;
    const tokenEconomyConfigPath = options.tokenEconomyConfigPath;
    const scopedDiffMetadataPath = options.scopedDiffMetadataPath;
    const outputPath = options.outputPath;
    const repoRoot = options.repoRoot;

    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    let tokenConfig: TokenEconomyConfig = {};
    if (tokenEconomyConfigPath && fs.existsSync(tokenEconomyConfigPath) && fs.statSync(tokenEconomyConfigPath).isFile()) {
        tokenConfig = JSON.parse(fs.readFileSync(tokenEconomyConfigPath, 'utf8')) as TokenEconomyConfig;
    }

    const enabled = parseBool(tokenConfig.enabled);
    const enabledDepths = [...new Set(
        toStringArray(tokenConfig.enabled_depths).filter(s => /^\d+$/.test(String(s).trim())).map(s => parseInt(String(s).trim(), 10))
    )].sort();
    const tokenEconomyActive = enabled && enabledDepths.includes(depth);

    const rulePack = getRulePack(reviewType);
    const fullRuleFiles = [...rulePack.full];
    const selectedRuleFiles = (!tokenEconomyActive || depth >= 3)
        ? [...fullRuleFiles]
        : selectRulePackFiles(reviewType, depth);

    const omittedRuleFiles = fullRuleFiles.filter(f => !selectedRuleFiles.includes(f));
    const ruleFilesBasePath = resolveGateExecutionPathPosix(repoRoot, 'live/docs/agent-rules');
    const selectedRulePaths = selectedRuleFiles.map(f => `${ruleFilesBasePath}/${f}`);
    const fullRulePaths = fullRuleFiles.map(f => `${ruleFilesBasePath}/${f}`);
    const omittedRulePaths = omittedRuleFiles.map(f => `${ruleFilesBasePath}/${f}`);
    const rulePackOmissionReason = omittedRulePaths.length > 0 ? 'deferred_by_depth' : 'none';

    const requiredReviews = preflight.required_reviews || {};
    const requiredReview = parseBool(requiredReviews[reviewType]);
    const taskId = String(preflight.task_id || '').trim() || null;
    const sourceOfTruth = readRuntimeReviewerProvider(repoRoot, taskId);
    const reviewerRoutingPolicy = resolveReviewerRoutingPolicy(sourceOfTruth);

    // Read plan metadata from task-mode evidence (optional, never blocks)
    let planMetadata: { plan_guided: boolean; plan_path: string | null; plan_sha256: string | null; plan_summary: string | null } = {
        plan_guided: false,
        plan_path: null,
        plan_sha256: null,
        plan_summary: null
    };
    if (taskId) {
        const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId);
        if (taskModeEvidence.plan) {
            planMetadata = {
                plan_guided: true,
                plan_path: taskModeEvidence.plan.plan_path,
                plan_sha256: taskModeEvidence.plan.plan_sha256,
                plan_summary: taskModeEvidence.plan.plan_summary
            };
        }
    }

    const stripExamplesFlag = parseBool(tokenConfig.strip_examples);
    const stripCodeBlocksFlag = parseBool(tokenConfig.strip_code_blocks);
    const scopedDiffsFlag = parseBool(tokenConfig.scoped_diffs);
    const compactReviewerOutputFlag = parseBool(tokenConfig.compact_reviewer_output);
    const failTailLines = toNonNegativeInt(tokenConfig.fail_tail_lines);
    const stripExamplesApplied = tokenEconomyActive && stripExamplesFlag;
    const stripCodeBlocksApplied = tokenEconomyActive && stripCodeBlocksFlag;
    const scopedDiffExpected = tokenEconomyActive && ['db', 'security', 'refactor'].includes(reviewType) && scopedDiffsFlag;

    let scopedDiffMetadata = null;
    if (scopedDiffMetadataPath && fs.existsSync(scopedDiffMetadataPath) && fs.statSync(scopedDiffMetadataPath).isFile()) {
        try {
            scopedDiffMetadata = JSON.parse(fs.readFileSync(scopedDiffMetadataPath, 'utf8'));
        } catch (exc) {
            scopedDiffMetadata = { metadata_path: normalizePath(scopedDiffMetadataPath), parse_error: String(exc) };
        }
    }

    const omittedSections = [];
    if (tokenEconomyActive && depth === 1) {
        omittedSections.push({
            section: 'rule_pack',
            reason: 'deferred_by_depth',
            details: 'Only minimal reviewer rule context is selected at depth=1.'
        });
    }
    if (tokenEconomyActive && stripExamplesFlag) {
        omittedSections.push({
            section: 'examples',
            reason: 'token_economy_strip_examples',
            details: 'Examples may be omitted from reviewer context.'
        });
    }
    if (tokenEconomyActive && stripCodeBlocksFlag) {
        omittedSections.push({
            section: 'code_blocks',
            reason: 'token_economy_strip_code_blocks',
            details: 'Code blocks may be omitted from reviewer context.'
        });
    }

    const tokenEconomyFlags = {
        enabled: !!enabled,
        enabled_depths: enabledDepths,
        strip_examples: stripExamplesFlag,
        strip_code_blocks: stripCodeBlocksFlag,
        scoped_diffs: scopedDiffsFlag,
        compact_reviewer_output: compactReviewerOutputFlag,
        fail_tail_lines: failTailLines
    };
    const tokenEconomyOmissionReason = (omittedSections.length > 0 || omittedRulePaths.length > 0) ? 'token_economy_compaction' : 'none';

    // Build the rule context artifact using gate-runtime
    const ruleContextArtifactPath = outputPath.replace(/\.json$/, '.md');
    const readFileCallback = (rulePath: string): string => {
        const resolved = path.isAbsolute(rulePath) ? rulePath : path.resolve(repoRoot, rulePath);
        try { return fs.readFileSync(resolved, 'utf8'); } catch { return ''; }
    };
    const ruleContextSections = buildReviewContextSections(selectedRulePaths, readFileCallback, {
        stripExamples: stripExamplesApplied,
        stripCodeBlocks: stripCodeBlocksApplied
    });

    const ruleContextArtifact = {
        artifact_path: normalizePath(ruleContextArtifactPath),
        artifact_sha256: ruleContextSections.artifact_sha256,
        source_file_count: ruleContextSections.source_file_count,
        strip_examples_applied: stripExamplesApplied,
        strip_code_blocks_applied: stripCodeBlocksApplied,
        summary: ruleContextSections.summary,
        source_files: ruleContextSections.source_files,
        preferred_prompt_artifact: normalizePath(ruleContextArtifactPath)
    };

    const compatibility = {
        note: 'Use nested rule_pack.* and token_economy.* fields. Legacy top-level duplicates were removed in schema_version=2.',
        legacy_top_level_fields_removed: {
            selected_rule_files: 'rule_pack.selected_rule_files',
            selected_rule_count: 'rule_pack.selected_rule_count',
            full_rule_pack_files: 'rule_pack.full_rule_pack_files',
            omitted_rule_files: 'rule_pack.omitted_rule_files',
            omitted_rule_count: 'rule_pack.omitted_rule_count',
            omission_reason: 'rule_pack.omission_reason',
            token_economy_flags: 'token_economy.flags',
            omitted_sections: 'token_economy.omitted_sections',
            omitted_sections_count: 'token_economy.omitted_sections_count'
        }
    };

    const result = {
        schema_version: 2,
        review_type: reviewType,
        depth,
        token_economy_active: !!tokenEconomyActive,
        required_review: !!requiredReview,
        preflight_path: normalizePath(preflightPath),
        output_path: normalizePath(outputPath),
        token_economy_config_path: normalizePath(tokenEconomyConfigPath),
        compatibility,
        rule_pack: {
            selected_rule_files: selectedRulePaths,
            selected_rule_count: selectedRulePaths.length,
            full_rule_pack_files: fullRulePaths,
            omitted_rule_files: omittedRulePaths,
            omitted_rule_count: omittedRulePaths.length,
            omission_reason: rulePackOmissionReason
        },
        token_economy: {
            active: !!tokenEconomyActive,
            flags: tokenEconomyFlags,
            omitted_sections: omittedSections,
            omitted_sections_count: omittedSections.length,
            omission_reason: tokenEconomyOmissionReason
        },
        rule_context: ruleContextArtifact,
        scoped_diff: {
            expected: !!scopedDiffExpected,
            metadata_path: normalizePath(scopedDiffMetadataPath),
            metadata: scopedDiffMetadata
        },
        reviewer_routing: {
            source_of_truth: reviewerRoutingPolicy.source_of_truth,
            capability_level: reviewerRoutingPolicy.capability_level,
            delegation_required: !!requiredReview && reviewerRoutingPolicy.delegation_required,
            expected_execution_mode: reviewerRoutingPolicy.expected_execution_mode,
            fallback_allowed: reviewerRoutingPolicy.fallback_allowed,
            fallback_reason_required: reviewerRoutingPolicy.fallback_reason_required,
            reviewer_execution_mode_required: !!requiredReview,
            reviewer_identity_required: !!requiredReview,
            actual_execution_mode: null as string | null,
            reviewer_session_id: null as string | null,
            fallback_reason: null as string | null,
            note: reviewerRoutingPolicy.note
        },
        plan: planMetadata
    };

    withReviewArtifactLock(outputPath, () => {
        writeArtifactFileAtomically(ruleContextArtifactPath, String(ruleContextSections.artifact_text));
        writeArtifactFileAtomically(outputPath, JSON.stringify(result, null, 2) + '\n');
    });

    return result;
}
