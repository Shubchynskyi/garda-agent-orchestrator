import { normalizePath, parseBool, toStringArray } from '../shared/helpers';
import { resolveGateExecutionPathPosix } from '../isolation/isolation-sandbox';

export interface ReviewRulePack {
    full: string[];
    depth1: string[];
    depth2: string[];
}

export interface TokenEconomyConfig {
    enabled?: unknown;
    enabled_depths?: unknown;
    strip_examples?: unknown;
    strip_code_blocks?: unknown;
    scoped_diffs?: unknown;
    compact_reviewer_output?: unknown;
    fail_tail_lines?: unknown;
}

export interface TokenEconomyOmittedSection {
    section: string;
    reason: string;
    details: string;
}

export interface ReviewContextTokenEconomyDecision {
    tokenEconomyActive: boolean;
    tokenEconomyFlags: {
        enabled: boolean;
        enabled_depths: number[];
        strip_examples: boolean;
        strip_code_blocks: boolean;
        scoped_diffs: boolean;
        compact_reviewer_output: boolean;
        fail_tail_lines: number | null;
    };
    fullRuleFiles: string[];
    selectedRuleFiles: string[];
    omittedRuleFiles: string[];
    fullRulePaths: string[];
    selectedRulePaths: string[];
    omittedRulePaths: string[];
    rulePackOmissionReason: string;
    stripExamplesApplied: boolean;
    stripCodeBlocksApplied: boolean;
    omittedSections: TokenEconomyOmittedSection[];
    tokenEconomyOmissionReason: string;
}

/**
 * Rule pack configuration by review type.
 * Matches Python get_rule_pack.
 */
export function getRulePack(reviewType: string): ReviewRulePack {
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

export function buildRuleContextSectionsCacheKey(
    selectedRulePaths: readonly string[],
    stripExamples: boolean,
    stripCodeBlocks: boolean
): string {
    return JSON.stringify({
        selectedRulePaths,
        stripExamples,
        stripCodeBlocks
    });
}

export function resolveReviewContextTokenEconomyDecision(options: {
    reviewType: string;
    depth: number;
    repoRoot: string;
    tokenConfig: TokenEconomyConfig;
}): ReviewContextTokenEconomyDecision {
    const enabled = parseBool(options.tokenConfig.enabled);
    const enabledDepths = [...new Set(
        toStringArray(options.tokenConfig.enabled_depths)
            .filter(s => /^\d+$/.test(String(s).trim()))
            .map(s => parseInt(String(s).trim(), 10))
    )].sort();
    const tokenEconomyActive = enabled && enabledDepths.includes(options.depth);

    const rulePack = getRulePack(options.reviewType);
    const fullRuleFiles = [...rulePack.full];
    const selectedRuleFiles = (!tokenEconomyActive || options.depth >= 3)
        ? [...fullRuleFiles]
        : selectRulePackFiles(options.reviewType, options.depth);
    const omittedRuleFiles = fullRuleFiles.filter(f => !selectedRuleFiles.includes(f));
    const ruleFilesBasePath = resolveGateExecutionPathPosix(options.repoRoot, 'live/docs/agent-rules');
    const selectedRulePaths = selectedRuleFiles.map(f => normalizePath(`${ruleFilesBasePath}/${f}`));
    const fullRulePaths = fullRuleFiles.map(f => normalizePath(`${ruleFilesBasePath}/${f}`));
    const omittedRulePaths = omittedRuleFiles.map(f => normalizePath(`${ruleFilesBasePath}/${f}`));
    const rulePackOmissionReason = omittedRulePaths.length > 0 ? 'deferred_by_depth' : 'none';

    const stripExamplesFlag = parseBool(options.tokenConfig.strip_examples);
    const stripCodeBlocksFlag = parseBool(options.tokenConfig.strip_code_blocks);
    const scopedDiffsFlag = parseBool(options.tokenConfig.scoped_diffs);
    const compactReviewerOutputFlag = parseBool(options.tokenConfig.compact_reviewer_output);
    const failTailLines = toNonNegativeInt(options.tokenConfig.fail_tail_lines);
    const stripExamplesApplied = tokenEconomyActive && stripExamplesFlag;
    const stripCodeBlocksApplied = tokenEconomyActive && stripCodeBlocksFlag;

    const omittedSections: TokenEconomyOmittedSection[] = [];
    if (tokenEconomyActive && options.depth === 1) {
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

    const tokenEconomyOmissionReason = (omittedSections.length > 0 || omittedRulePaths.length > 0)
        ? 'token_economy_compaction'
        : 'none';

    return {
        tokenEconomyActive,
        tokenEconomyFlags: {
            enabled: !!enabled,
            enabled_depths: enabledDepths,
            strip_examples: stripExamplesFlag,
            strip_code_blocks: stripCodeBlocksFlag,
            scoped_diffs: scopedDiffsFlag,
            compact_reviewer_output: compactReviewerOutputFlag,
            fail_tail_lines: failTailLines
        },
        fullRuleFiles,
        selectedRuleFiles,
        omittedRuleFiles,
        fullRulePaths,
        selectedRulePaths,
        omittedRulePaths,
        rulePackOmissionReason,
        stripExamplesApplied,
        stripCodeBlocksApplied,
        omittedSections,
        tokenEconomyOmissionReason
    };
}
