import * as path from 'node:path';

import { getProviderEntryById } from '../../../../core/provider-registry';
import { normalizePath } from '../../../../gates/shared/helpers';
import {
    resolveReviewerHandoffArtifactBinding,
} from '../../../../gates/review/review-prompt-artifact';
import { resolveRuntimeReviewerIdentity } from '../../../../gates/review/reviewer-routing';
import {
    getObjectField,
    getStringField,
    toReviewerHandoffAbsolutePath
} from '../support/review-handler-common';

export interface ReviewerHandoffBindings {
    rolePromptPath: string | null;
    rolePromptSha256: string | null;
    promptTemplatePath: string;
    promptTemplateSha256: string;
    outputTemplatePath: string;
    outputTemplateSha256: string;
    evidenceManifestPath: string;
    evidenceManifestSha256: string;
}

function quoteReviewerLaunchCommandValue(value: string): string {
    return `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function toRepoRelativeCommandPath(repoRoot: string, artifactPath: string): string {
    const relativePath = path.relative(repoRoot, artifactPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return normalizePath(artifactPath);
    }
    return normalizePath(relativePath);
}

export function getReviewerScopedDiffHandoffPaths(repoRoot: string, reviewContext: Record<string, unknown>) {
    const scopedDiff = getObjectField(reviewContext, 'scoped_diff');
    if (!scopedDiff) {
        return {
            metadataPath: '',
            outputPath: '',
            cachePath: ''
        };
    }
    const metadata = getObjectField(scopedDiff, 'metadata');
    return {
        metadataPath: toReviewerHandoffAbsolutePath(repoRoot, getStringField(scopedDiff, 'metadata_path')),
        outputPath: toReviewerHandoffAbsolutePath(repoRoot, metadata ? getStringField(metadata, 'output_path') : ''),
        cachePath: toReviewerHandoffAbsolutePath(repoRoot, metadata ? getStringField(metadata, 'cache_path', 'diff_cache_path') : getStringField(scopedDiff, 'diff_cache_path'))
    };
}

export function buildRecordReviewInvocationCommand(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextPath: string;
    reviewerLaunchArtifactPath: string;
}): string {
    const commandParts = [
        'node bin/garda.js gate record-review-invocation',
        '--task-id', quoteReviewerLaunchCommandValue(options.taskId),
        '--review-type', quoteReviewerLaunchCommandValue(options.reviewType),
        '--review-context-path', quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewContextPath)),
        '--reviewer-execution-mode', quoteReviewerLaunchCommandValue(options.reviewerExecutionMode),
        '--reviewer-identity', quoteReviewerLaunchCommandValue(options.reviewerIdentity),
        '--reviewer-launch-artifact-path', quoteReviewerLaunchCommandValue(toRepoRelativeCommandPath(options.repoRoot, options.reviewerLaunchArtifactPath)),
        '--repo-root', quoteReviewerLaunchCommandValue('.')
    ];
    return commandParts.join(' ');
}

export function resolveReviewerDraftOutputPath(reviewerLaunchArtifactPath: string): string {
    return path.join(path.dirname(reviewerLaunchArtifactPath), 'review-output.md');
}

export function buildCopyPasteReviewerLaunchPrompt(options: {
    repoRoot: string;
    reviewType: string;
    rolePromptPath: string | null;
    rolePromptSha256: string | null;
    reviewerPromptPath: string;
    reviewerPromptSha256: string;
    promptTemplatePath: string;
    promptTemplateSha256: string;
    outputTemplatePath: string;
    outputTemplateSha256: string;
    evidenceManifestPath: string;
    evidenceManifestSha256: string;
    reviewOutputPath: string;
}): string {
    const lines = [
        `You are the delegated ${options.reviewType} reviewer for this Garda task.`,
        `Repository: ${options.repoRoot}`
    ];
    if (options.rolePromptPath) {
        lines.push(`First open and read RolePromptPath: ${options.rolePromptPath}`);
        if (options.rolePromptSha256) {
            lines.push(`RolePromptSha256: ${options.rolePromptSha256}`);
        }
        lines.push(`Then open and read PromptTemplatePath: ${options.promptTemplatePath}`);
    } else {
        lines.push(`First open and read PromptTemplatePath: ${options.promptTemplatePath}`);
    }
    lines.push(
        `PromptTemplateSha256: ${options.promptTemplateSha256}`,
        `Then open and read ReviewerPromptPath: ${options.reviewerPromptPath}`,
        `ReviewerPromptSha256: ${options.reviewerPromptSha256}`,
        `Use EvidenceManifestPath to locate the review context, scoped diff, and supporting evidence: ${options.evidenceManifestPath}`,
        `EvidenceManifestSha256: ${options.evidenceManifestSha256}`,
        `Fill OutputTemplatePath exactly, preserving the required sections: ${options.outputTemplatePath}`,
        `OutputTemplateSha256: ${options.outputTemplateSha256}`,
        'Required sections: Validation Notes, Findings by Severity, Deferred Findings, Residual Risks, Verdict.',
        `Write the final review report to ReviewOutputPath when file writing is available, or return the filled report in your final response: ${options.reviewOutputPath}`,
        'Do not replace the required verdict token with a summary sentence.'
    );
    return lines.join('\n');
}

export function printCopyPasteReviewerLaunchPrompt(prompt: string): void {
    console.log('CopyPasteReviewerLaunchPrompt:');
    for (const line of prompt.split('\n')) {
        console.log(`  ${line}`);
    }
}

export function resolveReviewerHandoffBindings(options: {
    repoRoot: string;
    contextPath: string;
    reviewContext: Record<string, unknown>;
    gateName: string;
}): ReviewerHandoffBindings {
    const handoff = getObjectField(options.reviewContext, 'reviewer_handoff');
    const rolePrompt = handoff && getObjectField(handoff, 'role_prompt')
        ? resolveReviewerHandoffArtifactBinding({
            ...options,
            handoffKey: 'role_prompt',
            artifactLabel: 'reviewer role prompt'
        })
        : null;
    const promptTemplate = resolveReviewerHandoffArtifactBinding({
        ...options,
        handoffKey: 'prompt_template',
        artifactLabel: 'reviewer prompt template'
    });
    const outputTemplate = resolveReviewerHandoffArtifactBinding({
        ...options,
        handoffKey: 'output_template',
        artifactLabel: 'reviewer output template'
    });
    const evidenceManifest = resolveReviewerHandoffArtifactBinding({
        ...options,
        handoffKey: 'evidence_manifest',
        artifactLabel: 'reviewer evidence manifest'
    });
    return {
        rolePromptPath: rolePrompt?.artifactPath || null,
        rolePromptSha256: rolePrompt?.artifactSha256 || null,
        promptTemplatePath: promptTemplate.artifactPath,
        promptTemplateSha256: promptTemplate.artifactSha256,
        outputTemplatePath: outputTemplate.artifactPath,
        outputTemplateSha256: outputTemplate.artifactSha256,
        evidenceManifestPath: evidenceManifest.artifactPath,
        evidenceManifestSha256: evidenceManifest.artifactSha256
    };
}

export function getReviewTreeStateSha256(reviewContext: Record<string, unknown>): string {
    const treeState = reviewContext.tree_state
        && typeof reviewContext.tree_state === 'object'
        && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    return treeState
        ? getStringField(treeState, 'tree_state_sha256', 'treeStateSha256').toLowerCase()
        : '';
}

export function getReviewTreeStateLaunchSummary(reviewContext: Record<string, unknown>): Record<string, unknown> | null {
    const treeState = reviewContext.tree_state
        && typeof reviewContext.tree_state === 'object'
        && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    if (!treeState) {
        return null;
    }
    return {
        tree_state_sha256: getStringField(treeState, 'tree_state_sha256', 'treeStateSha256').toLowerCase(),
        detection_source: getStringField(treeState, 'detection_source', 'detectionSource'),
        use_staged: treeState.use_staged === true,
        include_untracked: treeState.include_untracked === true,
        changed_files: Array.isArray(treeState.changed_files) ? treeState.changed_files : [],
        stale_staged_snapshot_files: Array.isArray(treeState.stale_staged_snapshot_files)
            ? treeState.stale_staged_snapshot_files
            : []
    };
}

export function resolveProviderLaunchMetadata(runtimeIdentity: ReturnType<typeof resolveRuntimeReviewerIdentity>): {
    provider: string | null;
    launchTool: string;
    launchInstruction: string;
} {
    const provider = runtimeIdentity.execution_provider || runtimeIdentity.canonical_source_of_truth || null;
    const providerEntry = provider ? getProviderEntryById(provider) : null;
    return {
        provider,
        launchTool: providerEntry?.reviewerLaunchLabel || provider || 'delegated_subagent',
        launchInstruction: providerEntry?.delegatedReviewerLaunchInstruction
            || 'launch a clean-context reviewer sub-agent with isolated context.'
    };
}
