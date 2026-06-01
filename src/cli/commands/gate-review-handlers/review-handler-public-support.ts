import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    normalizeCompatibilityReviewerExecutionMode,
} from '../../../gate-runtime/review-context';
import * as gateHelpers from '../../../gates/helpers';
import { normalizePath } from '../../../gates/helpers';
import { resolveCanonicalReviewContextPath } from '../../../gates/review-context-paths';
import {
    resolveReviewerHandoffArtifactBinding,
} from '../../../gates/review-prompt-artifact';
import {
    resolveDefaultReviewScratchPath
} from '../../../gates/review-scratch-paths';
import { resolveRuntimeReviewerIdentity } from '../../../gates/reviewer-routing';
import { getProviderEntryById } from '../../../core/provider-registry';
import {
    isTaskOwnedReviewTempPath
} from '../gates-artifacts';
import {
    type ParsedOptionsRecord
} from '../shared-command-utils';
export {
    buildReviewerLaunchBindingSha256,
    resolveReviewerLaunchInputArtifactPath,
    resolveReviewerLaunchInputAttestation,
    REVIEWER_LAUNCH_INPUT_ARTIFACT_FILE_NAME,
    stringSha256,
    type ReviewerLaunchInputAttestation,
    type ReviewerLaunchInputMode
} from './review-launch-input-attestation';
export {
    assertPreparedReviewerLaunchArtifact,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingReviewerLaunchPreparedEvent,
    getCurrentPreparedReviewerLaunchMismatches,
    isCurrentCompletedReviewerLaunchArtifact,
    isForbiddenReviewerLaunchAttestationSource,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    normalizeReviewerLaunchAttestationSource,
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    snapshotSupersededReviewerLaunchArtifact,
    validateReviewerLaunchArtifact,
    type ReviewerLaunchArtifactValidationResult,
    type SupersededReviewerLaunchArtifactSnapshot
} from './review-launch-artifact-validation';
export {
    assertExplicitReviewContextRuntimeIdentity,
    assertNoCurrentCycleReviewRecordedBeforeRouting,
    assertReviewContextContractOrThrow,
    assertReviewContextRuntimeIdentityMetadataPresent,
    assertRoutingCompatibility,
    findMatchingReviewerInvocationAttestationEvent,
    findMatchingRoutingEvent
} from './review-context-runtime-validation';
export {
    analyzeEarlyReviewMaterialization,
    buildLosslessPassReviewNormalization,
    buildMinimalPassReviewTemplateHint,
    buildPassReviewTemplateHintMessage,
    isLosslessPassNormalizationEligibleViolation,
    reviewContextRequiresPassValidationNotes
} from './review-pass-normalization';

interface ResolvedCanonicalReviewPaths {
    preflightPath: string;
    reviewsRoot: string;
    artifactPath: string;
    contextPath: string;
}

interface ParsedReviewerIdentity {
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
}

interface ReviewerHandoffBindings {
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

export function toReviewerHandoffAbsolutePath(repoRoot: string, artifactPath: string): string {
    const trimmedPath = String(artifactPath || '').trim();
    if (!trimmedPath) {
        return '';
    }
    return normalizePath(path.isAbsolute(trimmedPath) ? trimmedPath : path.resolve(repoRoot, trimmedPath));
}

function getObjectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const value = record[key];
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
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

export function resolveCanonicalReviewPaths(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    preflightPathValue: unknown,
    reviewContextPathValue: unknown
): ResolvedCanonicalReviewPaths {
    const canonicalPreflightPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-preflight.json`)
    );
    assertArtifactPathRealpathInsideRepo(repoRoot, canonicalPreflightPath, 'PreflightPath');
    const resolvedPreflightPath = gateHelpers.resolvePathInsideRepo(String(preflightPathValue || ''), repoRoot, { allowMissing: true });
    if (!resolvedPreflightPath) {
        throw new Error('PreflightPath is required.');
    }
    assertArtifactPathRealpathInsideRepo(repoRoot, resolvedPreflightPath, 'PreflightPath');
    if (resolvedPreflightPath !== canonicalPreflightPath) {
        throw new Error(
            `PreflightPath must point to the canonical preflight artifact for '${taskId}': ` +
            `${normalizePath(canonicalPreflightPath)}.`
        );
    }
    const preflightPath = resolvedPreflightPath;
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Preflight artifact not found: ${preflightPath}`);
    }

    const reviewsRoot = path.dirname(preflightPath);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const contextPath = resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath: reviewContextPathValue ? String(reviewContextPathValue) : '',
        repoRoot
    });
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }

    return {
        preflightPath,
        reviewsRoot,
        artifactPath,
        contextPath
    };
}

function assertArtifactPathRealpathInsideRepo(repoRoot: string, artifactPath: string, label: string): void {
    if (!gateHelpers.isPathRealpathInsideRoot(artifactPath, repoRoot)) {
        throw new Error(
            `${label} must resolve inside repo root without symlink or junction escape: ` +
            `${normalizePath(artifactPath)}.`
        );
    }
}

export function resolveCanonicalPreflightArtifactPath(repoRoot: string, taskId: string): string {
    const preflightPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-preflight.json`));
    assertArtifactPathRealpathInsideRepo(repoRoot, preflightPath, 'PreflightPath');
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Preflight artifact not found: ${normalizePath(preflightPath)}.`);
    }
    return preflightPath;
}

export function parseReviewerIdentity(options: ParsedOptionsRecord, modeRequiredMessage: string): ParsedReviewerIdentity {
    const rawReviewerExecutionMode = options.reviewerExecutionMode
        ? String(options.reviewerExecutionMode).trim()
        : null;
    const reviewerExecutionMode = normalizeCompatibilityReviewerExecutionMode(rawReviewerExecutionMode);
    const reviewerIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : null;
    const reviewerFallbackReason = options.reviewerFallbackReason
        ? String(options.reviewerFallbackReason).trim()
        : null;

    if (!reviewerExecutionMode) {
        if (rawReviewerExecutionMode) {
            throw new Error(
                `ReviewerExecutionMode '${rawReviewerExecutionMode}' is invalid. ` +
                "Expected 'delegated_subagent'."
            );
        }
        throw new Error(modeRequiredMessage);
    }
    if (reviewerExecutionMode !== 'delegated_subagent') {
        throw new Error(
            `ReviewerExecutionMode '${reviewerExecutionMode}' is no longer supported. ` +
            "Mandatory reviews must use 'delegated_subagent'."
        );
    }
    if (!reviewerIdentity) {
        throw new Error('ReviewerIdentity is required.');
    }
    if (reviewerIdentity.startsWith('self:')) {
        throw new Error('Delegated review evidence cannot use a self-scoped reviewer identity.');
    }
    if (!reviewerIdentity.startsWith('agent:')) {
        throw new Error("Delegated review evidence requires an agent-scoped reviewer identity (prefix 'agent:').");
    }
    if (reviewerFallbackReason) {
        throw new Error(
            'ReviewerFallbackReason is not supported for delegated_subagent review evidence. ' +
            'Remove --reviewer-fallback-reason and rerun the delegated reviewer flow.'
        );
    }

    return {
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason
    };
}

export function readJsonFile(pathValue: string, label: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(pathValue, 'utf8')) as unknown;
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            throw new Error(`${label} must contain valid JSON: ${error.message}`);
        }
        throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} must contain a JSON object.`);
    }
    return parsed as Record<string, unknown>;
}

export function readJsonObjectIfPresent(pathValue: string): Record<string, unknown> | null {
    if (!fs.existsSync(pathValue) || !fs.statSync(pathValue).isFile()) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(pathValue, 'utf8')) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

export function getStringField(record: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (value == null) {
            continue;
        }
        const text = String(value).trim();
        if (text) {
            return text;
        }
    }
    return '';
}

function resolveDefaultReviewerLaunchArtifactPath(repoRoot: string, taskId: string, reviewType: string): string {
    return resolveDefaultReviewScratchPath(repoRoot, taskId, reviewType, 'reviewer-launch.json');
}

export function resolveReviewerLaunchArtifactPathForWrite(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    artifactPathValue: unknown;
}): string {
    const rawArtifactPath = String(options.artifactPathValue || '').trim()
        || resolveDefaultReviewerLaunchArtifactPath(options.repoRoot, options.taskId, options.reviewType);
    const artifactPath = gateHelpers.resolvePathInsideRepo(rawArtifactPath, options.repoRoot, { allowMissing: true });
    if (!artifactPath) {
        throw new Error('ReviewerLaunchArtifactPath could not be resolved.');
    }
    if (!isTaskOwnedReviewTempPath(options.repoRoot, options.taskId, artifactPath)) {
        throw new Error(
            `ReviewerLaunchArtifactPath must be task-owned under reviewer scratch storage for '${options.taskId}'. ` +
            `Got ${normalizePath(artifactPath)}.`
        );
    }
    return artifactPath;
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


