import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../core/constants';
import { buildReviewContextSections, type ReviewContextSectionsResult } from '../gate-runtime/review-context';
import { stringSha256 } from '../gate-runtime/hash';
import { withReviewArtifactLock, writeArtifactFileAtomically } from '../gate-runtime/review-artifacts';
import {
    REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
    REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION
} from '../gate-runtime/reviewer-session-contract';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    normalizePath,
    parseBool,
    resolvePathInsideRepo,
    toStringArray
} from './helpers';
import { resolveGateExecutionPathPosix } from './isolation-sandbox';
import { getCanonicalReviewContextPath } from './review-context-paths';
import {
    buildGitDiffSummary,
    readReviewContextChangedFiles,
    REVIEW_CONTEXT_DIFF_MAX_CHARS,
    REVIEW_CONTEXT_NON_CODE_PROMPT_DIFF_MAX_CHARS,
    type GitDiffSummary
} from './review-context-diff';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations,
} from './review-context-contract';
import {
    buildReviewTreeState,
    getReviewTreeStateBlockingViolations,
    type ReviewTreeState
} from './review-tree-state';
import { resolveRuntimeReviewerIdentity, type RuntimeReviewerIdentity } from './reviewer-routing';
import { getTaskModeEvidence } from './task-mode';
import { getReviewSkillCandidates, hasSkillEntrypoint } from '../core/review-capabilities';

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

export function resolveReviewSkillId(reviewType: string, repoRoot: string): string {
    const rulesRoot = path.resolve(repoRoot);
    for (const candidate of getReviewSkillCandidates(reviewType)) {
        const skillRoot = path.join(rulesRoot, resolveBundleName(), 'live', 'skills', candidate);
        if (hasSkillEntrypoint(skillRoot)) {
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
    return getCanonicalReviewContextPath(preflightDir, baseName, reviewType);
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

function summarizeBooleanRecord(record: unknown): string[] {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return [];
    }
    return Object.entries(record as Record<string, unknown>)
        .filter(([, value]) => value === true)
        .map(([key]) => key)
        .sort();
}

function buildReviewerOutputContractMarkdown(reviewType: string): string[] {
    const reviewLabel = reviewType ? `${reviewType} review` : 'review';
    return [
        '## Reviewer Output Contract',
        `- Return a canonical ${reviewLabel} report using exactly this section order and heading text:`,
        '```markdown',
        '## Findings by Severity',
        '<active findings by Critical/High/Medium/Low, or none>',
        '',
        '## Deferred Findings',
        '<accepted non-blocking follow-up with Justification:, or none>',
        '',
        '## Residual Risks',
        '<active open risks, or none>',
        '',
        '## Verdict',
        '<recognized PASS or FAIL verdict token>',
        '```',
        '- A no-findings PASS must still include 1-3 concise sentences naming the reviewed files and behavior checked.',
        '- Do not return only headings, `none`, and a PASS verdict; record-review-result rejects trivial or obviously synthetic reports.',
        '- Keep PASS analysis compact and concrete; put accepted non-blocking follow-ups only in Deferred Findings with `Justification:`.',
        ''
    ];
}

function buildTaskScopeMarkdown(options: {
    taskId: string | null;
    reviewType: string;
    depth: number;
    preflightPath: string;
    preflightSha256: string | null;
    preflight: Record<string, unknown>;
    changedFiles: string[];
    requiredReviews: string[];
    activeTriggers: string[];
    gitDiff: GitDiffSummary;
    treeState: ReviewTreeState | null;
}): string {
    const lines: string[] = [];
    const fullDiffText = options.gitDiff.diff || '';
    const promptDiffMaxChars = options.reviewType === 'code'
        ? REVIEW_CONTEXT_DIFF_MAX_CHARS
        : REVIEW_CONTEXT_NON_CODE_PROMPT_DIFF_MAX_CHARS;
    const promptDiffText = fullDiffText.slice(0, promptDiffMaxChars);
    const promptDiffExcerptTruncated = fullDiffText.length > promptDiffMaxChars;
    const diffFence = buildMarkdownFence(promptDiffText, 'diff');
    const statFence = buildMarkdownFence(options.gitDiff.stat || '', 'text');
    lines.push(`# Review Context: ${options.taskId || '<unknown>'} ${options.reviewType}`);
    lines.push('');
    lines.push('## Task Scope');
    lines.push(`- Review type: ${options.reviewType}`);
    lines.push(`- Depth: ${options.depth}`);
    lines.push(`- Path mode: ${String(options.preflight.mode || 'unknown')}`);
    lines.push(`- Scope category: ${String(options.preflight.scope_category || 'unknown')}`);
    lines.push(`- Preflight path: ${normalizePath(options.preflightPath)}`);
    lines.push(`- Preflight sha256: ${options.preflightSha256 || 'unknown'}`);
    lines.push(`- Required reviews: ${options.requiredReviews.length > 0 ? options.requiredReviews.join(', ') : 'none'}`);
    lines.push(`- Active triggers: ${options.activeTriggers.length > 0 ? options.activeTriggers.join(', ') : 'none'}`);
    lines.push('');
    lines.push('## Changed Files');
    if (options.changedFiles.length === 0) {
        lines.push('- none');
    } else {
        for (const changedFile of options.changedFiles) {
            lines.push(`- ${changedFile}`);
        }
    }
    lines.push('');
    lines.push('## Review Tree State');
    if (options.treeState) {
        lines.push(`- Detection source: ${options.treeState.detection_source}`);
        lines.push(`- Use staged snapshot: ${options.treeState.use_staged}`);
        lines.push(`- Include untracked files: ${options.treeState.include_untracked}`);
        lines.push(`- Tree state sha256: ${options.treeState.tree_state_sha256 || 'unknown'}`);
        lines.push(`- Scope sha256: ${options.treeState.scope_sha256 || 'unknown'}`);
        lines.push(`- Stale staged snapshot files: ${options.treeState.stale_staged_snapshot_files.length > 0 ? options.treeState.stale_staged_snapshot_files.join(', ') : 'none'}`);
    } else {
        lines.push('- unavailable');
    }
    lines.push('');
    lines.push('## Current Diff Stat');
    if (options.gitDiff.stat) {
        lines.push(statFence.open);
        lines.push(options.gitDiff.stat);
        lines.push(statFence.close);
    } else {
        lines.push(options.gitDiff.error ? `Unavailable: ${options.gitDiff.error}` : 'none');
    }
    lines.push('');
    lines.push('## Current Scoped Diff');
    if (promptDiffText) {
        lines.push(diffFence.open);
        lines.push(promptDiffText);
        if (options.gitDiff.diff_truncated || promptDiffExcerptTruncated) {
            lines.push('');
            if (options.reviewType === 'code' && !promptDiffExcerptTruncated) {
                lines.push(`[diff truncated at ${REVIEW_CONTEXT_DIFF_MAX_CHARS} chars from ${options.gitDiff.diff_char_count} chars]`);
            } else {
                const fullBoundedNote = options.gitDiff.diff_truncated
                    ? ` from ${options.gitDiff.diff_char_count} chars`
                    : '';
                const cacheNote = options.gitDiff.cache_path
                    ? `; full bounded scoped diff cache: ${options.gitDiff.cache_path}`
                    : '';
                lines.push(`[diff excerpt truncated at ${promptDiffMaxChars} chars${fullBoundedNote}${cacheNote}]`);
            }
        }
        lines.push(diffFence.close);
    } else {
        lines.push(options.gitDiff.error ? `Unavailable: ${options.gitDiff.error}` : 'none');
    }
    lines.push('');
    lines.push(...buildReviewerOutputContractMarkdown(options.reviewType));
    lines.push('## Rule Context');
    return lines.join('\n');
}

function buildMarkdownFence(content: string, info: string): { open: string; close: string } {
    const longestFence = [...content.matchAll(/`{3,}/g)]
        .reduce((maxLength, match) => Math.max(maxLength, match[0].length), 2);
    const fence = '`'.repeat(longestFence + 1);
    return {
        open: `${fence}${info}`,
        close: fence
    };
}

function shouldIncludeUntrackedForReviewTreeState(preflight: Record<string, unknown>): boolean {
    const detectionSource = String(preflight.detection_source || '').trim().toLowerCase();
    return detectionSource === 'git_staged_plus_untracked'
        || detectionSource === 'git_auto'
        || detectionSource === 'explicit_changed_files';
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
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

export interface BuildReviewContextOptions {
    reviewType: string;
    depth: number;
    preflightPath: string;
    preflightPayload?: Record<string, unknown> | null;
    taskModePath?: string | null;
    taskModeEvidence?: ReturnType<typeof getTaskModeEvidence> | null;
    runtimeReviewerIdentity?: RuntimeReviewerIdentity | null;
    tokenEconomyConfigPath: string;
    tokenEconomyConfigData?: TokenEconomyConfig | null;
    scopedDiffMetadataPath: string;
    outputPath: string;
    repoRoot: string;
    ruleContextSectionsCache?: Map<string, ReviewContextSectionsResult> | null;
    ruleFileContentCache?: Map<string, string> | null;
}

function assertArtifactRealpathInsideRepo(
    repoRoot: string,
    artifactPath: string,
    label: string,
    options: { allowMissing?: boolean } = {}
): void {
    if (!isPathRealpathInsideRoot(artifactPath, repoRoot, { allowMissing: options.allowMissing === true })) {
        throw new Error(`${label} must resolve inside repo root without symlink or junction escape: ${normalizePath(artifactPath)}.`);
    }
}

function buildRuleContextSectionsCacheKey(
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

    assertArtifactRealpathInsideRepo(repoRoot, preflightPath, 'PreflightPath');
    assertArtifactRealpathInsideRepo(repoRoot, outputPath, 'OutputPath', { allowMissing: true });
    if (scopedDiffMetadataPath) {
        assertArtifactRealpathInsideRepo(repoRoot, scopedDiffMetadataPath, 'ScopedDiffMetadataPath', { allowMissing: true });
    }
    if (tokenEconomyConfigPath) {
        assertArtifactRealpathInsideRepo(repoRoot, tokenEconomyConfigPath, 'TokenEconomyConfigPath', { allowMissing: true });
    }

    const preflight = options.preflightPayload ?? JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    let tokenConfig: TokenEconomyConfig = options.tokenEconomyConfigData || {};
    if (
        !options.tokenEconomyConfigData
        && tokenEconomyConfigPath
        && fs.existsSync(tokenEconomyConfigPath)
        && fs.statSync(tokenEconomyConfigPath).isFile()
    ) {
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
    const taskModeEvidence = options.taskModeEvidence || (
        taskId
            ? getTaskModeEvidence(repoRoot, taskId, options.taskModePath || '')
            : null
    );
    const runtimeIdentity = options.runtimeReviewerIdentity || resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId,
        taskModePath: options.taskModePath || '',
        taskModeEvidence,
        allowLegacyFallback: true
    });
    const runtimeIdentityViolations = [...runtimeIdentity.violations];
    if (!runtimeIdentity.canonical_source_of_truth) {
        runtimeIdentityViolations.push('Pinned canonical_source_of_truth is missing from task-mode identity evidence.');
    }
    if (!runtimeIdentity.execution_provider) {
        runtimeIdentityViolations.push('Pinned execution_provider is missing from task-mode identity evidence.');
    }
    if (runtimeIdentity.identity_status !== 'resolved') {
        runtimeIdentityViolations.push(
            `Active runtime identity for task '${taskId || '<unknown>'}' is '${runtimeIdentity.identity_status}'. ` +
            'Re-enter task mode with explicit runtime identity before preparing review context.'
        );
    }
    if (runtimeIdentityViolations.length > 0) {
        throw new Error(
            `Review context cannot be built because runtime identity is invalid. ${runtimeIdentityViolations.join(' ')}`
        );
    }
    if (runtimeIdentity.reviewer_subagent_launch_status !== 'launchable') {
        const launchReason = runtimeIdentity.reviewer_subagent_launch_reason || 'Reviewer subagent launch is unavailable for this runtime session.';
        const launchRemediation = runtimeIdentity.reviewer_subagent_launch_remediation
            ? ` ${runtimeIdentity.reviewer_subagent_launch_remediation}`
            : '';
        throw new Error(
            `Review context cannot be built for review '${reviewType}' because delegated reviewer launch is not attested. ` +
            `${launchReason}${launchRemediation} Re-enter task mode, rerun handshake-diagnostics, and then rerun build-review-context.`
        );
    }

    // Read plan metadata from task-mode evidence (optional, never blocks)
    let planMetadata: { plan_guided: boolean; plan_path: string | null; plan_sha256: string | null; plan_summary: string | null } = {
        plan_guided: false,
        plan_path: null,
        plan_sha256: null,
        plan_summary: null
    };
    if (taskModeEvidence?.plan) {
            planMetadata = {
                plan_guided: true,
                plan_path: taskModeEvidence.plan.plan_path,
                plan_sha256: taskModeEvidence.plan.plan_sha256,
                plan_summary: taskModeEvidence.plan.plan_summary
            };
    }

    const stripExamplesFlag = parseBool(tokenConfig.strip_examples);
    const stripCodeBlocksFlag = parseBool(tokenConfig.strip_code_blocks);
    const scopedDiffsFlag = parseBool(tokenConfig.scoped_diffs);
    const compactReviewerOutputFlag = parseBool(tokenConfig.compact_reviewer_output);
    const failTailLines = toNonNegativeInt(tokenConfig.fail_tail_lines);
    const stripExamplesApplied = tokenEconomyActive && stripExamplesFlag;
    const stripCodeBlocksApplied = tokenEconomyActive && stripCodeBlocksFlag;
    const changedFiles = readReviewContextChangedFiles(preflight.changed_files);
    const diffExpectations = buildReviewContextPreflightDiffExpectations(preflight, reviewType);
    const scopedDiffExpected = diffExpectations.expectedScopedDiff;

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
    const requiredReviewTypes = summarizeBooleanRecord(preflight.required_reviews);
    const activeTriggers = summarizeBooleanRecord(preflight.triggers);
    const preflightMetrics = asPlainRecord(preflight.metrics);
    const treeState = buildReviewTreeState({
        repoRoot,
        detectionSource: preflight.detection_source,
        includeUntracked: shouldIncludeUntrackedForReviewTreeState(preflight),
        changedFiles,
        metrics: preflightMetrics
    });
    const treeStateViolations = getReviewTreeStateBlockingViolations(treeState);
    if (treeStateViolations.length > 0) {
        throw new Error(
            `Review context cannot be built because reviewer-visible tree state is incoherent. ` +
            treeStateViolations.join(' ')
        );
    }
    const gitDiff = buildGitDiffSummary(repoRoot, changedFiles, preflight, preflightPath);
    const preflightSha256 = fileSha256(preflightPath);
    const taskScopeMarkdown = buildTaskScopeMarkdown({
        taskId,
        reviewType,
        depth,
        preflightPath,
        preflightSha256,
        preflight,
        changedFiles,
        requiredReviews: requiredReviewTypes,
        activeTriggers,
        gitDiff,
        treeState
    });

    const ruleContextArtifactPath = outputPath.replace(/\.json$/, '.md');
    assertArtifactRealpathInsideRepo(repoRoot, ruleContextArtifactPath, 'RuleContextArtifactPath', { allowMissing: true });
    const readFileCallback = (rulePath: string): string => {
        if (options.ruleFileContentCache?.has(rulePath)) {
            return String(options.ruleFileContentCache.get(rulePath) || '');
        }
        const resolved = path.isAbsolute(rulePath) ? rulePath : path.resolve(repoRoot, rulePath);
        try {
            const content = fs.readFileSync(resolved, 'utf8');
            options.ruleFileContentCache?.set(rulePath, content);
            return content;
        } catch {
            options.ruleFileContentCache?.set(rulePath, '');
            return '';
        }
    };
    const ruleContextSectionsCacheKey = buildRuleContextSectionsCacheKey(
        selectedRulePaths,
        stripExamplesApplied,
        stripCodeBlocksApplied
    );
    let ruleContextSections = options.ruleContextSectionsCache?.get(ruleContextSectionsCacheKey) || null;
    if (!ruleContextSections) {
        ruleContextSections = buildReviewContextSections(selectedRulePaths, readFileCallback, {
            stripExamples: stripExamplesApplied,
            stripCodeBlocks: stripCodeBlocksApplied
        });
        options.ruleContextSectionsCache?.set(ruleContextSectionsCacheKey, ruleContextSections);
    }
    const promptArtifactText = `${taskScopeMarkdown}\n\n${ruleContextSections.artifact_text}`;

    const ruleContextArtifact = {
        artifact_path: normalizePath(ruleContextArtifactPath),
        artifact_sha256: stringSha256(promptArtifactText),
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
        task_id: taskId,
        review_type: reviewType,
        depth,
        token_economy_active: !!tokenEconomyActive,
        required_review: !!requiredReview,
        preflight_path: normalizePath(preflightPath),
        preflight_sha256: preflightSha256,
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
        task_scope: {
            changed_files: changedFiles,
            changed_file_count: changedFiles.length,
            required_reviews: requiredReviewTypes,
            active_triggers: activeTriggers,
            diff_stat: gitDiff.stat,
            diff: {
                available: !!gitDiff.diff,
                source: gitDiff.source,
                char_count: gitDiff.diff_char_count,
                truncated: gitDiff.diff_truncated,
                max_chars: REVIEW_CONTEXT_DIFF_MAX_CHARS,
                prompt_max_chars: reviewType === 'code'
                    ? REVIEW_CONTEXT_DIFF_MAX_CHARS
                    : REVIEW_CONTEXT_NON_CODE_PROMPT_DIFF_MAX_CHARS,
                command_status: gitDiff.command_status,
                error: gitDiff.error,
                cache_path: gitDiff.cache_path,
                cached: gitDiff.cached,
                diff_sha256: stringSha256(gitDiff.diff || '') || null
            }
        },
        tree_state: treeState,
        scoped_diff: {
            expected: !!scopedDiffExpected,
            metadata_path: normalizePath(scopedDiffMetadataPath),
            metadata: scopedDiffMetadata
        },
        reviewer_routing: {
            source_of_truth: runtimeIdentity.execution_provider,
            canonical_source_of_truth: runtimeIdentity.canonical_source_of_truth,
            canonical_entrypoint: runtimeIdentity.canonical_entrypoint,
            execution_provider: runtimeIdentity.execution_provider,
            execution_provider_source: runtimeIdentity.execution_provider_source,
            routed_to: runtimeIdentity.routed_to,
            provider_bridge: runtimeIdentity.provider_bridge,
            identity_status: runtimeIdentity.identity_status,
            capability_level: runtimeIdentity.capability_level,
            delegation_required: !!requiredReview && runtimeIdentity.delegation_required,
            expected_execution_mode: runtimeIdentity.expected_execution_mode,
            fallback_allowed: runtimeIdentity.fallback_allowed,
            fallback_reason_required: runtimeIdentity.fallback_reason_required,
            reviewer_subagent_launch_status: runtimeIdentity.reviewer_subagent_launch_status,
            reviewer_subagent_launch_route: runtimeIdentity.reviewer_subagent_launch_route,
            reviewer_subagent_launch_reason: runtimeIdentity.reviewer_subagent_launch_reason,
            reviewer_subagent_launch_remediation: runtimeIdentity.reviewer_subagent_launch_remediation,
            reviewer_execution_mode_required: !!requiredReview,
            reviewer_identity_required: !!requiredReview,
            fresh_context_required: !!requiredReview,
            fresh_context_instruction: requiredReview ? REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION : null,
            opaque_handoff_required: !!requiredReview,
            opaque_handoff_instruction: requiredReview ? REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION : null,
            reviewer_session_reuse_forbidden: !!requiredReview,
            reviewer_session_reuse_note: requiredReview ? REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION : null,
            cleanup_required_after_receipt: !!requiredReview,
            cleanup_instruction: requiredReview ? REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION : null,
            actual_execution_mode: null as string | null,
            reviewer_session_id: null as string | null,
            fallback_reason: null as string | null,
            note: runtimeIdentity.note,
            identity_violations: runtimeIdentity.violations
        },
        plan: planMetadata
    };

    const diffMaterialViolations = getReviewContextContractViolations({
        contextPath: outputPath,
        reviewContext: result,
        expectedTaskId: taskId,
        expectedReviewType: reviewType,
        expectedPreflightPath: preflightPath,
        expectedPreflightSha256: preflightSha256,
        requireReviewType: true,
        requireTaskId: true,
        requirePreflightPath: true,
        requirePreflightSha256: true,
        ...diffExpectations
    });
    if (diffMaterialViolations.length > 0) {
        throw new Error(
            `Review context cannot be built because required diff material is missing. ` +
            diffMaterialViolations.join(' ')
        );
    }

    withReviewArtifactLock(outputPath, () => {
        writeArtifactFileAtomically(ruleContextArtifactPath, promptArtifactText);
        writeArtifactFileAtomically(outputPath, JSON.stringify(result, null, 2) + '\n');
    });

    return result;
}
