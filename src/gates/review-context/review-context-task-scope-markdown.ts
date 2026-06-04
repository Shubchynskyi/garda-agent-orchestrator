import { buildReviewerOutputContractMarkdown } from './review-context-artifacts';
import {
    REVIEW_CONTEXT_DIFF_MAX_CHARS,
    REVIEW_CONTEXT_NON_CODE_PROMPT_DIFF_MAX_CHARS,
    type GitDiffSummary
} from './review-context-diff';
import { buildTaskCriteriaMarkdown, type ReviewContextTaskCriteria } from './review-context-task-criteria';
import {
    buildFullSuiteValidationEvidenceMarkdown,
    type ReviewContextFullSuiteValidationEvidence
} from './review-context-validation-evidence';
import {
    buildManualValidationEvidenceMarkdown,
    type ReviewContextManualValidationEvidence
} from './review-context-manual-validation-evidence';
import { prioritizePromptDiffForReview } from './review-context-prompt-diff';
import { type ReviewTreeState } from '../review/review-tree-state';
import { normalizePath } from '../shared/helpers';

export function buildTaskScopeMarkdown(options: {
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
    fullSuiteValidation: ReviewContextFullSuiteValidationEvidence | null;
    manualValidation: ReviewContextManualValidationEvidence | null;
    taskCriteria: ReviewContextTaskCriteria;
    rolePromptArtifactPath: string;
    promptTemplateArtifactPath: string;
    outputTemplateArtifactPath: string;
    evidenceManifestArtifactPath: string;
}): string {
    const lines: string[] = [];
    const fullDiffText = options.gitDiff.diff || '';
    const promptDiffSourceText = prioritizePromptDiffForReview(options.reviewType, fullDiffText);
    const promptDiffMaxChars = options.reviewType === 'code' || options.reviewType === 'api'
        ? REVIEW_CONTEXT_DIFF_MAX_CHARS
        : REVIEW_CONTEXT_NON_CODE_PROMPT_DIFF_MAX_CHARS;
    const promptDiffText = promptDiffSourceText.slice(0, promptDiffMaxChars);
    const promptDiffExcerptTruncated = promptDiffSourceText.length > promptDiffMaxChars;
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
    lines.push(...buildTaskCriteriaMarkdown(options.taskCriteria));
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
    if (options.fullSuiteValidation) {
        lines.push(...buildFullSuiteValidationEvidenceMarkdown(options.fullSuiteValidation));
        lines.push('');
    }
    if (options.manualValidation) {
        lines.push(...buildManualValidationEvidenceMarkdown(options.manualValidation));
        lines.push('');
    }
    lines.push(...buildReviewerOutputContractMarkdown({
        reviewType: options.reviewType,
        rolePromptArtifactPath: options.rolePromptArtifactPath,
        promptTemplateArtifactPath: options.promptTemplateArtifactPath,
        outputTemplateArtifactPath: options.outputTemplateArtifactPath,
        evidenceManifestArtifactPath: options.evidenceManifestArtifactPath
    }));
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
