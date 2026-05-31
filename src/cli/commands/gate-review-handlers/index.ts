import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance,
    buildReviewReceiptReviewerProvenance,
    buildReviewVerdictTokenSet,
    extractReviewVerdictToken,
    formatAcceptedReviewVerdictTokens,
    normalizeCompatibilityReviewerExecutionMode,
    restoreReviewerRoutingMetadata
} from '../../../gate-runtime/review-context';
import {
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION
} from '../../../gate-runtime/reviewer-session-contract';
import {
    assertValidTaskId,
    taskEventAppendHasBlockingFailure
} from '../../../gate-runtime/task-events';
import { fileSha256 } from '../../../gate-runtime/hash';
import {
    emitReviewRecordedEventAsync
} from '../../../gate-runtime/lifecycle-events';
import {
    captureReviewArtifactRollbackState,
    restoreReviewArtifactFromRollbackState,
    writeReviewArtifactText,
    writeReviewArtifactsWithRollback
} from '../../../gate-runtime/review-artifacts';
import * as gateHelpers from '../../../gates/helpers';
import { normalizePath } from '../../../gates/helpers';
import { REVIEW_CONTRACTS } from '../../../gates/required-reviews-check';
import {
    assertRequiredUpstreamReviewDependencies,
    type ReviewDependencyTimelineEvent
} from '../../../gates/review-dependencies';
import {
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    computeReviewContextReuseHash,
    isNonTestReviewScope
} from '../../../gates/review-reuse';
import {
    buildDomainScopeFingerprints
} from '../../../gates/domain-scope-fingerprints';
import { resolveCanonicalReviewContextPath } from '../../../gates/review-context-paths';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from '../../../gates/review-context-contract';
import {
    assertReviewTreeStateFresh
} from '../../../gates/review-tree-state';
import {
    resolveReviewerHandoffArtifactBinding,
    resolveReviewerPromptArtifactBinding
} from '../../../gates/review-prompt-artifact';
import {
    resolveDefaultReviewScratchPath
} from '../../../gates/review-scratch-paths';
import { resolveReviewContextRoutingIdentity } from '../../../gates/review-context-routing';
import { assertReviewLifecycleGuard } from '../../../gates/review-lifecycle-guard';
import { normalizeRuntimeIdentitySource, resolveRuntimeReviewerIdentity } from '../../../gates/reviewer-routing';
import { getProviderEntryById } from '../../../core/provider-registry';
import {
    extractMarkdownSectionLines,
    getCanonicalReviewSectionHeading,
    getMarkdownMeaningfulEntries,
    getReviewArtifactFindingsEvidence,
    isTrivialReview,
    normalizeCanonicalReviewSectionHeadings
} from '../../../gates/completion';
import {
    cleanupReviewTempSourceArtifact,
    isTaskOwnedReviewTempPath
} from '../gates-artifacts';
import {
    parseOptions,
    normalizePathValue
} from '../cli-helpers';
import {
    type ParsedOptionsRecord
} from '../shared-command-utils';
import {
    readDependencyTimelineEvents
} from './review-dependency-timeline';
import {
    resolveReviewOutputInput
} from './review-output-input';
import {
    materializeReviewContent
} from './review-artifact-materialization';
import {
    assertReviewReceiptRoutingMatchesContext
} from './review-receipt-validation';
import {
    createReviewRoutingLaunchHandlers
} from './review-routing-launch-handlers';
import {
    createReviewInvocationHandlers
} from './review-invocation-handlers';

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

export interface SupersededReviewerLaunchArtifactSnapshot {
    artifact_path: string;
    artifact_sha256: string;
    snapshot_path: string;
    superseded_reason: string;
    mismatches: string[];
}

type ReviewerLaunchInputMode = 'copy_paste_prompt' | 'launch_artifact_path';

interface ReviewerLaunchInputAttestation {
    mode: ReviewerLaunchInputMode;
    sha256: string;
    copyPasteReviewerLaunchPromptSha256: string;
    artifactPath: string | null;
    artifactSha256: string | null;
}

export const PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch_preparation';
export const COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch';
export const PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE = 'garda_prepare_reviewer_launch';
const REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT: ReviewerLaunchInputMode = 'copy_paste_prompt';
const REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH: ReviewerLaunchInputMode = 'launch_artifact_path';
export const REVIEWER_LAUNCH_INPUT_ARTIFACT_FILE_NAME = 'reviewer-launch-input.json';
const REVIEWER_LAUNCH_INPUT_MODES = new Set<ReviewerLaunchInputMode>([
    REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT,
    REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH
]);
const FORBIDDEN_COMPLETED_REVIEWER_LAUNCH_ATTESTATION_SOURCES = new Set([
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    'orchestrator_mock',
    'mock',
    'manual'
]);
export const LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY = (
    'Local reviewer launch artifacts are convenience metadata for a real delegated reviewer launch; ' +
    'they are not non-forgeable proof without provider-owned recording.'
);
export const REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS = Object.freeze([
    "evidence_type='delegated_reviewer_launch'",
    "attestation_state='launched'",
    'attestation_source=<provider/controller source, not garda_prepare_reviewer_launch/manual/mock>',
    'provider_invocation_id or controller_invocation_id=<actual delegated reviewer invocation id>',
    'launched_at_utc=<gate-owned UTC timestamp recorded by complete-reviewer-launch>',
    'launch_input_mode=copy_paste_prompt or launch_artifact_path',
    'launch_input_sha256=<sha256 of exact CopyPasteReviewerLaunchPrompt or ReviewerLaunchInputArtifactPath>',
    'fresh_context=true, isolated_context=true, or fork_context=false'
]);

export function stringSha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function normalizeReviewerLaunchAttestationSource(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

export function isForbiddenReviewerLaunchAttestationSource(value: string): boolean {
    return FORBIDDEN_COMPLETED_REVIEWER_LAUNCH_ATTESTATION_SOURCES.has(
        normalizeReviewerLaunchAttestationSource(value)
    );
}

export function buildReviewerLaunchBindingSha256(options: {
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256: string | null;
}): string {
    return stringSha256([
        `task_id=${options.taskId}`,
        `review_type=${options.reviewType}`,
        `reviewer_execution_mode=${options.reviewerExecutionMode}`,
        `reviewer_identity=${options.reviewerIdentity}`,
        `review_context_sha256=${options.reviewContextSha256}`,
        `routing_event_sha256=${options.routingEventSha256}`,
        `reviewer_prompt_sha256=${options.reviewerPromptSha256 || ''}`
    ].join('\n'));
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

export function resolveReviewerLaunchInputArtifactPath(reviewerLaunchArtifactPath: string): string {
    return path.join(path.dirname(reviewerLaunchArtifactPath), REVIEWER_LAUNCH_INPUT_ARTIFACT_FILE_NAME);
}

function getPreparedReviewerLaunchInputArtifactPath(
    repoRoot: string,
    preparedArtifact: Record<string, unknown>
): string | null {
    const rawPath = getStringField(
        preparedArtifact,
        'reviewer_launch_input_artifact_path',
        'reviewerLaunchInputArtifactPath'
    );
    if (!rawPath) {
        return null;
    }
    return gateHelpers.resolvePathInsideRepo(rawPath, repoRoot, { allowMissing: true });
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

function normalizeReviewerLaunchInputMode(value: unknown): ReviewerLaunchInputMode | null {
    const normalized = String(value || '').trim().toLowerCase();
    return REVIEWER_LAUNCH_INPUT_MODES.has(normalized as ReviewerLaunchInputMode)
        ? normalized as ReviewerLaunchInputMode
        : null;
}

function normalizeSha256Hex(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function resolveCopyPasteReviewerLaunchPromptSha256(
    artifact: Record<string, unknown>,
    violations: string[]
): string {
    const copyPastePrompt = getStringField(
        artifact,
        'copy_paste_reviewer_launch_prompt',
        'copyPasteReviewerLaunchPrompt'
    );
    const copyPastePromptSha256 = normalizeSha256Hex(
        getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt_sha256',
            'copyPasteReviewerLaunchPromptSha256'
        )
    );
    if (!copyPastePrompt) {
        violations.push('copy_paste_reviewer_launch_prompt is required for launch input fidelity');
        return copyPastePromptSha256;
    }
    const expectedCopyPastePromptSha256 = stringSha256(copyPastePrompt);
    if (!copyPastePromptSha256) {
        violations.push('copy_paste_reviewer_launch_prompt_sha256 is required');
        return expectedCopyPastePromptSha256;
    }
    if (!/^[0-9a-f]{64}$/.test(copyPastePromptSha256)) {
        violations.push('copy_paste_reviewer_launch_prompt_sha256 must be a lowercase sha256 hex digest');
        return copyPastePromptSha256;
    }
    if (copyPastePromptSha256 !== expectedCopyPastePromptSha256) {
        violations.push('copy_paste_reviewer_launch_prompt_sha256 must match copy_paste_reviewer_launch_prompt');
    }
    return copyPastePromptSha256;
}

export function resolveReviewerLaunchInputAttestation(options: {
    repoRoot: string;
    launchArtifactPath: string;
    preparedArtifact: Record<string, unknown>;
    preparedLaunchArtifactSha256: string;
    rawMode: unknown;
    rawSha256: unknown;
    rawArtifactPath: unknown;
}): ReviewerLaunchInputAttestation {
    const violations: string[] = [];
    const copyPasteReviewerLaunchPromptSha256 = resolveCopyPasteReviewerLaunchPromptSha256(
        options.preparedArtifact,
        violations
    );
    const mode = normalizeReviewerLaunchInputMode(options.rawMode);
    if (!mode) {
        violations.push(
            `launch_input_mode is required and must be '${REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT}' ` +
            `or '${REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH}'`
        );
    }
    const launchInputSha256 = normalizeSha256Hex(options.rawSha256);
    if (!launchInputSha256) {
        violations.push('launch_input_sha256 is required');
    } else if (!/^[0-9a-f]{64}$/.test(launchInputSha256)) {
        violations.push('launch_input_sha256 must be a lowercase sha256 hex digest');
    }

    let launchInputArtifactPath: string | null = null;
    let launchInputArtifactSha256: string | null = null;
    if (mode === REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT) {
        if (launchInputSha256 && copyPasteReviewerLaunchPromptSha256 && launchInputSha256 !== copyPasteReviewerLaunchPromptSha256) {
            violations.push('launch_input_sha256 must match copy_paste_reviewer_launch_prompt_sha256 for copy_paste_prompt mode');
        }
    } else if (mode === REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH) {
        const rawArtifactPath = String(options.rawArtifactPath || '').trim();
        if (!rawArtifactPath) {
            violations.push('launch_input_artifact_path is required for launch_artifact_path mode');
        } else {
            const resolvedArtifactPath = gateHelpers.resolvePathInsideRepo(rawArtifactPath, options.repoRoot, { allowMissing: true });
            if (!resolvedArtifactPath) {
                violations.push('launch_input_artifact_path could not be resolved inside the repository');
            } else {
                const preparedInputArtifactPath = getPreparedReviewerLaunchInputArtifactPath(
                    options.repoRoot,
                    options.preparedArtifact
                );
                const normalizedResolvedArtifactPath = normalizePath(resolvedArtifactPath).toLowerCase();
                const normalizedLaunchArtifactPath = normalizePath(options.launchArtifactPath).toLowerCase();
                const normalizedPreparedInputArtifactPath = preparedInputArtifactPath
                    ? normalizePath(preparedInputArtifactPath).toLowerCase()
                    : '';
                if (
                    normalizedResolvedArtifactPath !== normalizedLaunchArtifactPath
                    && normalizedResolvedArtifactPath !== normalizedPreparedInputArtifactPath
                ) {
                    violations.push('launch_input_artifact_path must match ReviewerLaunchInputArtifactPath or ReviewerLaunchArtifactPath');
                } else {
                    launchInputArtifactPath = resolvedArtifactPath;
                }
            }
        }
        if (!options.preparedLaunchArtifactSha256) {
            violations.push('prepared reviewer launch artifact could not be hashed before completion');
        } else if (launchInputArtifactPath) {
            const resolvedInputArtifactSha256 = fileSha256(launchInputArtifactPath) || '';
            if (!resolvedInputArtifactSha256) {
                violations.push('launch_input_artifact_path must point to a hashable reviewer launch input artifact');
            } else {
                launchInputArtifactSha256 = resolvedInputArtifactSha256;
                if (resolvedInputArtifactSha256 !== options.preparedLaunchArtifactSha256) {
                    violations.push('launch_input_artifact_sha256 must match the current prepared reviewer launch artifact sha256');
                }
                if (launchInputSha256 && launchInputSha256 !== resolvedInputArtifactSha256) {
                    violations.push('launch_input_sha256 must match the current prepared reviewer launch input artifact sha256');
                }
            }
        }
    }

    if (violations.length > 0) {
        throw new Error(
            'Reviewer launch input attestation failed validation:\n' +
            violations.map((violation) => `- ${violation}`).join('\n') +
            '\n\n' +
            'Pass the exact CopyPasteReviewerLaunchPrompt or generated ReviewerLaunchInputArtifactPath to the reviewer; ' +
            'do not reconstruct reviewer launch prompts from memory.'
        );
    }

    return {
        mode: mode!,
        sha256: launchInputSha256,
        copyPasteReviewerLaunchPromptSha256,
        artifactPath: launchInputArtifactPath,
        artifactSha256: launchInputArtifactSha256
    };
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

function getReviewerLaunchArtifactMismatchReasons(
    artifact: Record<string, unknown>,
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: 'delegated_subagent';
        reviewerIdentity: string;
        reviewContextSha256: string;
        routingEventSha256: string;
        reviewerPromptSha256: string | null;
        rolePromptSha256?: string | null;
        promptTemplateSha256?: string | null;
        outputTemplateSha256?: string | null;
        evidenceManifestSha256?: string | null;
        reviewOutputPath?: string | null;
        copyPasteReviewerLaunchPrompt?: string | null;
        copyPasteReviewerLaunchPromptSha256?: string | null;
        reviewTreeStateSha256: string | null;
        launchBindingSha256: string;
        preparedLaunchEventSha256: string;
        routingEventSequence: number;
        timelineEvents: readonly ReviewDependencyTimelineEvent[];
    }
): string[] {
    const mismatches: string[] = [];
    if (getStringField(artifact, 'task_id', 'taskId') !== options.taskId) {
        mismatches.push('task_id mismatch');
    }
    if (getStringField(artifact, 'review_type', 'reviewType').toLowerCase() !== options.reviewType) {
        mismatches.push('review_type mismatch');
    }
    if (getStringField(artifact, 'reviewer_execution_mode', 'reviewerExecutionMode') !== options.reviewerExecutionMode) {
        mismatches.push('reviewer_execution_mode mismatch');
    }
    if (
        getStringField(artifact, 'reviewer_identity', 'reviewerIdentity', 'reviewer_session_id', 'reviewerSessionId') !== options.reviewerIdentity
    ) {
        mismatches.push('reviewer_identity mismatch');
    }
    if (getStringField(artifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase() !== options.reviewContextSha256) {
        mismatches.push('review_context_sha256 mismatch');
    }
    if (getStringField(artifact, 'routing_event_sha256', 'routingEventSha256').toLowerCase() !== options.routingEventSha256) {
        mismatches.push('routing_event_sha256 mismatch');
    }
    if (
        options.reviewerPromptSha256
        && getStringField(artifact, 'reviewer_prompt_sha256', 'reviewerPromptSha256').toLowerCase() !== options.reviewerPromptSha256
    ) {
        mismatches.push('reviewer_prompt_sha256 mismatch');
    }
    if (
        options.rolePromptSha256
        && getStringField(artifact, 'role_prompt_sha256', 'rolePromptSha256').toLowerCase() !== options.rolePromptSha256
    ) {
        mismatches.push('role_prompt_sha256 mismatch');
    }
    if (
        options.promptTemplateSha256
        && getStringField(artifact, 'prompt_template_sha256', 'promptTemplateSha256').toLowerCase() !== options.promptTemplateSha256
    ) {
        mismatches.push('prompt_template_sha256 mismatch');
    }
    if (
        options.outputTemplateSha256
        && getStringField(artifact, 'output_template_sha256', 'outputTemplateSha256').toLowerCase() !== options.outputTemplateSha256
    ) {
        mismatches.push('output_template_sha256 mismatch');
    }
    if (
        options.evidenceManifestSha256
        && getStringField(artifact, 'evidence_manifest_sha256', 'evidenceManifestSha256').toLowerCase() !== options.evidenceManifestSha256
    ) {
        mismatches.push('evidence_manifest_sha256 mismatch');
    }
    if (
        options.reviewOutputPath
        && getStringField(artifact, 'review_output_path', 'reviewOutputPath') !== normalizePath(options.reviewOutputPath)
    ) {
        mismatches.push('review_output_path mismatch');
    }
    if (
        options.copyPasteReviewerLaunchPrompt
        && getStringField(artifact, 'copy_paste_reviewer_launch_prompt', 'copyPasteReviewerLaunchPrompt') !== options.copyPasteReviewerLaunchPrompt
    ) {
        mismatches.push('copy_paste_reviewer_launch_prompt mismatch');
    }
    if (
        options.copyPasteReviewerLaunchPromptSha256
        && getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt_sha256',
            'copyPasteReviewerLaunchPromptSha256'
        ).toLowerCase() !== options.copyPasteReviewerLaunchPromptSha256
    ) {
        mismatches.push('copy_paste_reviewer_launch_prompt_sha256 mismatch');
    }
    if (
        options.reviewTreeStateSha256
        && getStringField(artifact, 'review_tree_state_sha256', 'reviewTreeStateSha256').toLowerCase() !== options.reviewTreeStateSha256
    ) {
        mismatches.push('review_tree_state_sha256 mismatch');
    }
    if (getStringField(artifact, 'launch_binding_sha256', 'launchBindingSha256').toLowerCase() !== options.launchBindingSha256) {
        mismatches.push('launch_binding_sha256 mismatch');
    }
    if (
        getStringField(artifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256').toLowerCase()
            !== options.preparedLaunchEventSha256
    ) {
        mismatches.push('prepared_launch_event_sha256 mismatch');
    } else if (
        !findMatchingReviewerLaunchPreparedEvent(options.timelineEvents, {
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            launchBindingSha256: options.launchBindingSha256,
            preparedLaunchEventSha256: options.preparedLaunchEventSha256,
            minSequenceExclusive: options.routingEventSequence
        })
    ) {
        mismatches.push('prepared_launch_event_sha256 is not current telemetry');
    }
    return mismatches;
}

function resolveCanonicalReviewPaths(
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

export { handleRequiredReviewsCheck, handleDocImpactGate } from './simple-handlers';

export let readReviewOutputFromStdin = async (): Promise<string> => {
    if (!process.stdin || process.stdin.isTTY) {
        throw new Error('ReviewOutputStdin requires piped stdin input.');
    }
    process.stdin.setEncoding('utf8');
    let content = '';
    for await (const chunk of process.stdin) {
        content += String(chunk);
    }
    return content;
};

function getReviewHeading(reviewType: string): string {
    const normalized = String(reviewType || '').trim().toLowerCase();
    switch (normalized) {
        case 'api':
            return 'API Review';
        case 'db':
            return 'DB Review';
        case 'infra':
            return 'Infra Review';
        case 'security':
            return 'Security Review';
        case 'refactor':
            return 'Refactor Review';
        case 'performance':
            return 'Performance Review';
        case 'dependency':
            return 'Dependency Review';
        case 'test':
            return 'Test Review';
        case 'code':
        default:
            return 'Code Review';
    }
}

function buildMinimalPassReviewTemplateHint(reviewType: string, expectedPassVerdict: string): string {
    return [
        'Minimal compliant PASS review template for a no-findings review (structure only; substantive analysis is still required):',
        `Exact accepted PASS verdict token for '${reviewType}': ${expectedPassVerdict}`,
        `# ${getReviewHeading(reviewType)}`,
        '',
        '## Validation Notes',
        'Validated the relevant files with concrete scope notes, file references, behavior boundaries, and verification evidence.',
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Deferred Findings',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        expectedPassVerdict,
        "Use '## Deferred Findings' only for real accepted actionable follow-ups with 'Justification:'. Validation-boundary notes and command logs are prose only; keep the findings, deferred, and residual sections set to 'none'."
    ].join('\n');
}

type ReviewFindingsEvidence = ReturnType<typeof getReviewArtifactFindingsEvidence>;

function getPassValidationNotesViolations(options: {
    artifactPath: string;
    reviewContent: string;
    verdictToken: string;
    expectedPassVerdict: string;
    requirePassValidationNotes: boolean;
}): string[] {
    if (!options.requirePassValidationNotes || options.verdictToken !== options.expectedPassVerdict) {
        return [];
    }
    const normalizedArtifactPath = normalizePath(options.artifactPath);
    const lines = String(options.reviewContent || '').split('\n');
    const validationLines = extractMarkdownSectionLines(lines, 'Validation Notes');
    if (validationLines.length === 0) {
        return [
            `Review artifact '${normalizedArtifactPath}' is missing required PASS section '## Validation Notes'. ` +
            'Fill it with concrete reviewed files, behavior, boundaries, and verification evidence.'
        ];
    }
    const entries = getMarkdownMeaningfulEntries(validationLines);
    const joinedEntries = entries.join(' ').trim();
    const hasConcreteReference = /`[^`]+`/.test(joinedEntries)
        || /\b[A-Za-z0-9_./-]+\.[A-Za-z0-9]+(?::\d+)?\b/.test(joinedEntries);
    if (entries.length === 0 || joinedEntries.length < 80 || !hasConcreteReference) {
        return [
            `Review artifact '${normalizedArtifactPath}' has empty or non-substantive PASS validation notes. ` +
            'The `## Validation Notes` section must name concrete reviewed files and summarize checked behavior, boundaries, or verification evidence.'
        ];
    }
    return [];
}

function analyzeEarlyReviewMaterialization(options: {
    artifactPath: string;
    reviewContent: string;
    verdictToken: string;
    expectedPassVerdict: string;
    requirePassValidationNotes: boolean;
}): { violations: string[]; findingsEvidence: ReviewFindingsEvidence } {
    const { artifactPath, reviewContent, verdictToken, expectedPassVerdict } = options;
    const violations: string[] = [];
    const normalizedArtifactPath = normalizePath(artifactPath);
    if (isTrivialReview(reviewContent)) {
        violations.push(
            `Review artifact '${normalizedArtifactPath}' is trivial or obviously synthetic. ` +
            'Meaningful review artifacts must include implementation details and carry at least 100 characters of content.'
        );
    }
    violations.push(...getPassValidationNotesViolations(options));

    const findingsEvidence = getReviewArtifactFindingsEvidence(artifactPath, reviewContent);
    const requireCleanPassArtifact = verdictToken === expectedPassVerdict;
    const passOnlyActiveViolations = new Set<string>();
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
        if (findingsEvidence.findings_by_severity[severity].length === 0) {
            continue;
        }
        const severityLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
        passOnlyActiveViolations.add(
            `Review artifact '${normalizedArtifactPath}' still contains active ${severityLabel} findings. ` +
            "Resolve active defects. Only real accepted actionable follow-ups belong in 'Deferred Findings' with 'Justification:'; validation-boundary or command/log notes must stay out of strict follow-up sections."
        );
    }
    if (findingsEvidence.residual_risks.length > 0) {
        passOnlyActiveViolations.add(
            `Review artifact '${normalizedArtifactPath}' still contains active residual risks. ` +
            "For validation-boundary or command/log notes, set 'Residual Risks' and 'Deferred Findings' to 'none' and keep the note in prose. Only real accepted actionable follow-ups belong in 'Deferred Findings' with 'Justification:' and will require follow-up tracking."
        );
    }
    for (const violation of findingsEvidence.violations) {
        // Every recorded review must remain structurally auditable. Only the
        // "clean pass" requirement is verdict-specific; failed reviews still
        // materialize with active findings when the lifecycle sections exist.
        if (!passOnlyActiveViolations.has(violation) || requireCleanPassArtifact) {
            violations.push(violation);
        }
    }

    return {
        violations,
        findingsEvidence
    };
}

function reviewContextRequiresPassValidationNotes(contextPath: string, repoRoot: string): boolean {
    const reviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    const handoff = reviewContext.reviewer_handoff && typeof reviewContext.reviewer_handoff === 'object' && !Array.isArray(reviewContext.reviewer_handoff)
        ? reviewContext.reviewer_handoff as Record<string, unknown>
        : null;
    if (!handoff) {
        return false;
    }
    const outputTemplateBinding = resolveReviewerHandoffArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext,
        gateName: 'record-review-result',
        handoffKey: 'output_template',
        artifactLabel: 'reviewer output template'
    });
    const outputTemplateText = fs.readFileSync(outputTemplateBinding.artifactPath, 'utf8');
    return outputTemplateText.includes('## Validation Notes');
}

function hasMarkdownHeading(reviewContent: string, heading: string): boolean {
    return String(reviewContent || '')
        .split('\n')
        .some((rawLine) => {
            const headingMatch = /^(#{2,6})\s+(.+?)\s*$/.exec(rawLine.trim());
            const canonicalHeading = getCanonicalReviewSectionHeading(rawLine);
            return canonicalHeading
                ? canonicalHeading.toLowerCase() === heading.trim().toLowerCase()
                : !!headingMatch && headingMatch[2].trim().toLowerCase() === heading.trim().toLowerCase();
        });
}

function buildNoFindingsPassReviewRecoveryHint(options: {
    reviewContent: string;
    findingsEvidence: ReviewFindingsEvidence;
}): string | null {
    const { reviewContent, findingsEvidence } = options;
    const activeFindingsCount = Object.values(findingsEvidence.findings_by_severity)
        .reduce((total, entries) => total + entries.length, 0);
    if (activeFindingsCount > 0) {
        return null;
    }

    const hintLines: string[] = [];
    const findingsSectionPresent = hasMarkdownHeading(reviewContent, 'Findings by Severity');
    const residualSectionPresent = hasMarkdownHeading(reviewContent, 'Residual Risks');
    const deferredSectionPresent = hasMarkdownHeading(reviewContent, 'Deferred Findings');
    const deferredSectionLines = extractMarkdownSectionLines(String(reviewContent || '').split('\n'), 'Deferred Findings');
    const deferredSectionLooksEmpty = deferredSectionPresent
        && deferredSectionLines.length > 0
        && findingsEvidence.deferred_findings.length === 0
        && findingsEvidence.invalid_deferred_findings.length === 0;

    if (findingsEvidence.missing_sections.includes('Findings by Severity')) {
        hintLines.push(findingsSectionPresent
            ? "Set '## Findings by Severity' explicitly to 'none' when no findings remain open."
            : "Add mandatory section '## Findings by Severity' and set it to 'none' when no findings remain open.");
    }
    if (findingsEvidence.residual_risks.length > 0) {
        hintLines.push(
            "'## Residual Risks' is only for active open risks. For validation-boundary or command/log notes in a no-findings PASS review, keep those notes in prose and set '## Residual Risks' and '## Deferred Findings' to 'none'. Only real accepted actionable follow-ups belong in '## Deferred Findings' with 'Justification:' and become follow-up obligations."
        );
    } else if (findingsEvidence.missing_sections.includes('Residual Risks')) {
        hintLines.push(residualSectionPresent
            ? "Set '## Residual Risks' explicitly to 'none' when no active risks remain."
            : "Add mandatory section '## Residual Risks' and set it to 'none' when no active risks remain.");
    }
    if (findingsEvidence.invalid_deferred_findings.length > 0) {
        hintLines.push(
            "Every real '## Deferred Findings' entry must include 'Justification:' and becomes a follow-up obligation. If nothing actionable is deferred, remove that section or set it to 'none'; do not put validation-boundary or command/log notes there."
        );
    } else if (deferredSectionLooksEmpty) {
        hintLines.push(
            "'## Deferred Findings' may be omitted, but if you keep it for a no-findings PASS review, set it explicitly to 'none'."
        );
    }

    if (hintLines.length === 0) {
        return null;
    }
    return [
        'No-findings PASS review recovery:',
        ...hintLines.map((line) => `- ${line}`)
    ].join('\n');
}

function buildPassReviewTemplateHintMessage(options: {
    reviewType: string;
    verdictToken: string;
    expectedPassVerdict: string;
    reviewContent: string;
    findingsEvidence: ReviewFindingsEvidence;
}): string | null {
    if (options.verdictToken !== options.expectedPassVerdict) {
        return null;
    }
    const targetedHint = buildNoFindingsPassReviewRecoveryHint({
        reviewContent: options.reviewContent,
        findingsEvidence: options.findingsEvidence
    });
    const templateHint = buildMinimalPassReviewTemplateHint(options.reviewType, options.expectedPassVerdict);
    return targetedHint ? `${targetedHint}\n\n${templateHint}` : templateHint;
}

const CANONICAL_REVIEW_SECTION_HEADINGS = new Set([
    'findings by severity',
    'deferred findings',
    'residual risks',
    'verdict'
]);

function trimBlankLineEdges(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim().length === 0) {
        start += 1;
    }
    while (end > start && lines[end - 1].trim().length === 0) {
        end -= 1;
    }
    return lines.slice(start, end);
}

function stripMarkdownListPrefix(entry: string): string {
    return String(entry || '')
        .replace(/^\s*[-*+]\s+/, '')
        .replace(/^\s*\d+\.\s+/, '')
        .trim();
}

function extractReviewPreambleLines(reviewType: string, reviewContent: string): string[] {
    const lines = String(reviewContent || '').split('\n');
    const preamble: string[] = [];
    for (const line of lines) {
        const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
        const canonicalHeading = getCanonicalReviewSectionHeading(line);
        if (canonicalHeading || (headingMatch && CANONICAL_REVIEW_SECTION_HEADINGS.has(headingMatch[2].trim().toLowerCase()))) {
            break;
        }
        preamble.push(line);
    }
    const trimmed = trimBlankLineEdges(preamble);
    if (trimmed.length > 0) {
        return trimmed;
    }
    return [`# ${getReviewHeading(reviewType)}`];
}

function appendDeferredFinding(lines: string[], entry: string): void {
    const normalizedEntry = stripMarkdownListPrefix(entry);
    if (!normalizedEntry) {
        return;
    }
    lines.push(`- ${normalizedEntry}`);
    if (!/\bJustification\s*:/iu.test(normalizedEntry)) {
        lines.push('  Justification: Preserved from raw reviewer output during PASS review normalization.');
    }
    lines.push('');
}

function appendPreservedRawReviewerOutput(lines: string[], reviewContent: string): void {
    lines.push('## Preserved Raw Reviewer Output');
    lines.push('');
    for (const line of String(reviewContent || '').replace(/\r\n/g, '\n').split('\n')) {
        lines.push(line.length > 0 ? `> ${line}` : '>');
    }
    lines.push('');
}

function normalizeReviewNoteText(entry: string): string {
    return stripMarkdownListPrefix(entry)
        .replace(/^\[[^\]]+\]\s*/, '')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const PASS_REVIEW_COMMAND_HEADING_PATTERN = /^commands?(?:\s+(?:run|ran|i ran))?\s*:/u;

function isCommandOnlyValidationNote(normalizedEntry: string): boolean {
    if (!normalizedEntry || normalizedEntry.length > 180) {
        return false;
    }
    return /^(npm|pnpm|yarn|node|npx|git|tsc|vitest|jest|pytest|go test|cargo test|dotnet test|rg|grep|findstr|get-content|get-childitem|select-string|test-path|where-object|select-object|powershell|pwsh)\b/u.test(normalizedEntry)
        && !/\b(fail|failed|failure|error|regression|bug|missing|must|should|need|needs|fix|block|risk|vulnerab\w*|exploit\w*|unsafe|leak\w*|corrupt\w*|advisor(?:y|ies)|cve|rce|xss|credential\w*|secret\w*|token\w*|injection|traversal)\b/u.test(normalizedEntry);
}

function isGenericPassValidationBoundaryNote(
    entry: string,
    options: { filterStandaloneCommandNotes?: boolean } = {}
): boolean {
    const filterStandaloneCommandNotes = options.filterStandaloneCommandNotes ?? true;
    const normalizedEntry = normalizeReviewNoteText(entry);
    if (!normalizedEntry || normalizedEntry === 'none') {
        return true;
    }
    if (PASS_REVIEW_COMMAND_HEADING_PATTERN.test(normalizedEntry)) {
        return true;
    }
    if (filterStandaloneCommandNotes && isCommandOnlyValidationNote(normalizedEntry)) {
        return true;
    }

    const boundaryPatterns = [
        /\bfull (repository )?(test )?suite (was )?not run\b/u,
        /\bdid not run (the )?(entire|full|repository) (test )?suite\b/u,
        /\bdid not run tests?\b/u,
        /\btests? (were|was) not run\b/u,
        /\breview artifact (did not|does not|cannot) include (an )?(inline|scoped) diff\b/u,
        /\b(inline|scoped) diff (was )?(not included|not attached|omitted|absent|unavailable)\b/u,
        /\bwithout (an )?(inline|scoped) diff\b/u,
        /\bread[- ]only review\b/u,
        /\bfocused review only\b/u,
        /\bfocused validation\b/u,
        /\bfull[- ]suite validation (already )?(passed|ran|is gate[- ]owned|was covered)\b/u,
        /\bgate[- ]owned (compile|full[- ]suite|validation)\b/u,
        /\bcovered by (the )?(compile|full[- ]suite|mandatory) gate\b/u,
        /\bi did not identify (a )?(blocking )?(lifecycle|routing|review|test|regression|issue|risk|defect)/u,
        /\bcould not execute (the )?.*tests? directly\b/u,
        /\brequires the project'?s normal test harness\b/u,
        /\bdirect invocation fails at module loading\b/u,
        /\bbased on code inspection\b.*\b(correctly wired|coverage was added|coverage is present)\b/u,
        /\benforcement is correctly wired\b/u,
        /\bcould be sensitive to extreme clock skew\b/u,
        /\blow residual risk\b.*\bsuite passed\b/u,
        /\bspeculative\b.*\b(performance|environment|risk|hypothetical)/u
    ];
    if (boundaryPatterns.some((pattern) => pattern.test(normalizedEntry))) {
        return true;
    }

    const summarySignals = [
        'reviewed ',
        'validated ',
        'verified ',
        'checked ',
        'confirmed '
    ];
    const activeIssueSignals = /\b(fail|failed|failure|bug|defect|regression|vulnerability|exploit|unsafe|leak|corrupt|advisory|advisories|cve|rce|xss|credential|credentials|secret|secrets|token|tokens|injection|traversal|break|broken|missing|must|should|need|needs|fix|blocker|blocking|risk|follow[- ]up|actionable)\b/u;
    return summarySignals.some((signal) => normalizedEntry.startsWith(signal))
        && /\b(no|not|without)\b/u.test(normalizedEntry)
        && !activeIssueSignals.test(normalizedEntry);
}

function filterGenericPassValidationBoundaryEntries(
    entries: readonly string[],
    options: { filterStandaloneCommandNotes?: boolean } = {}
): string[] {
    const filteredEntries: string[] = [];
    let commandBlockActive = false;
    for (const entry of entries) {
        const normalizedEntry = normalizeReviewNoteText(entry);
        if (PASS_REVIEW_COMMAND_HEADING_PATTERN.test(normalizedEntry)) {
            commandBlockActive = true;
            continue;
        }
        if (commandBlockActive && isCommandOnlyValidationNote(normalizedEntry)) {
            continue;
        }
        commandBlockActive = false;
        if (isGenericPassValidationBoundaryNote(entry, options)) {
            continue;
        }
        filteredEntries.push(entry);
    }
    return filteredEntries;
}

function isLosslessPassNormalizationEligibleViolation(violation: string): boolean {
    const normalizedViolation = String(violation || '').toLowerCase();
    return normalizedViolation.includes('still contains active ')
        || normalizedViolation.includes("deferred finding without usable 'justification:'");
}

function dedupeReviewFollowUpEntries(entries: readonly string[]): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const entry of entries) {
        const key = normalizeReviewNoteText(entry);
        if (!key || seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(entry);
    }
    return deduped;
}

function buildLosslessPassReviewNormalization(options: {
    reviewType: string;
    reviewContent: string;
    expectedPassVerdict: string;
    findingsEvidence: ReviewFindingsEvidence;
}): string | null {
    const {
        reviewType,
        reviewContent,
        expectedPassVerdict,
        findingsEvidence
    } = options;
    const activeFindings = (['critical', 'high', 'medium', 'low'] as const)
        .flatMap((severity) => findingsEvidence.findings_by_severity[severity].map((entry) => `[${severity}] ${entry}`));
    const rawDeferredEntries = dedupeReviewFollowUpEntries(findingsEvidence.deferred_findings);
    const invalidDeferredEntries = dedupeReviewFollowUpEntries(findingsEvidence.invalid_deferred_findings);
    const rawResidualRiskEntries = findingsEvidence.residual_risks.map((entry) => `[follow-up] ${entry}`);
    const rawSourceEntries = dedupeReviewFollowUpEntries([
        ...rawDeferredEntries,
        ...invalidDeferredEntries,
        ...activeFindings,
        ...rawResidualRiskEntries
    ]);
    const activeResidualRisks = filterGenericPassValidationBoundaryEntries(
        rawResidualRiskEntries,
        { filterStandaloneCommandNotes: false }
    );
    const activeInvalidDeferredEntries = filterGenericPassValidationBoundaryEntries(invalidDeferredEntries);
    if (activeFindings.length > 0 || activeResidualRisks.length > 0 || activeInvalidDeferredEntries.length > 0) {
        return null;
    }
    const deferredEntries = filterGenericPassValidationBoundaryEntries(rawDeferredEntries);
    const rawPendingDeferredEntries = dedupeReviewFollowUpEntries(deferredEntries);
    if (rawSourceEntries.length === 0) {
        return null;
    }
    const pendingDeferredEntries = rawPendingDeferredEntries;

    const normalizedLines = [...extractReviewPreambleLines(reviewType, reviewContent)];
    if (normalizedLines.length === 0 || !normalizedLines[0].trim().startsWith('#')) {
        normalizedLines.unshift(`# ${getReviewHeading(reviewType)}`);
    }
    if (normalizedLines[normalizedLines.length - 1]?.trim().length !== 0) {
        normalizedLines.push('');
    }
    appendPreservedRawReviewerOutput(normalizedLines, reviewContent);
    const validationNotesLines = extractMarkdownSectionLines(String(reviewContent || '').split('\n'), 'Validation Notes');
    if (validationNotesLines.length > 0) {
        normalizedLines.push('## Validation Notes');
        normalizedLines.push(...validationNotesLines);
        if (normalizedLines[normalizedLines.length - 1]?.trim().length !== 0) {
            normalizedLines.push('');
        }
    }
    normalizedLines.push('## Findings by Severity');
    normalizedLines.push('none');
    normalizedLines.push('');
    normalizedLines.push('## Deferred Findings');
    normalizedLines.push('');
    if (pendingDeferredEntries.length === 0) {
        normalizedLines.push('none');
    } else {
        for (const entry of pendingDeferredEntries) {
            appendDeferredFinding(normalizedLines, entry);
        }
        if (normalizedLines[normalizedLines.length - 1]?.trim().length === 0) {
            normalizedLines.pop();
        }
    }
    normalizedLines.push('');
    normalizedLines.push('## Residual Risks');
    normalizedLines.push('none');
    normalizedLines.push('');
    normalizedLines.push('## Verdict');
    normalizedLines.push(expectedPassVerdict);
    return `${normalizedLines.join('\n')}\n`;
}

export function assertRoutingCompatibility(
    options: {
        reviewType: string;
        runtimeIdentity: ReturnType<typeof resolveRuntimeReviewerIdentity>;
        currentRouting: Record<string, unknown> | null;
        reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>;
        reviewerFallbackReason: string | null;
    }
): void {
    const {
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    } = options;
    const capabilityLevel = runtimeIdentity.capability_level;
    const expectedExecutionMode = runtimeIdentity.expected_execution_mode;
    const fallbackAllowed = runtimeIdentity.fallback_allowed;
    const fallbackReasonRequired = runtimeIdentity.fallback_reason_required;
    const providerLabel = runtimeIdentity.execution_provider
        || runtimeIdentity.canonical_source_of_truth
        || String(currentRouting?.execution_provider || currentRouting?.source_of_truth || 'unknown');
    if (reviewerExecutionMode !== 'delegated_subagent') {
        throw new Error(
            `Review '${reviewType}' must use delegated_subagent for provider '${providerLabel}'.`
        );
    }
    if (capabilityLevel !== 'delegation_required' && capabilityLevel !== 'unknown') {
        throw new Error(
            `Review '${reviewType}' resolved unexpected reviewer capability '${capabilityLevel}' ` +
            `for provider '${providerLabel}'.`
        );
    }
    if (expectedExecutionMode !== 'delegated_subagent' || !runtimeIdentity.delegation_required) {
        throw new Error(
            `Review '${reviewType}' resolved a non-delegated reviewer routing policy for provider '${providerLabel}'. ` +
            'Mandatory reviews require delegated_subagent execution.'
        );
    }
    if (fallbackAllowed || fallbackReasonRequired || reviewerFallbackReason) {
        throw new Error(
            `Review '${reviewType}' encountered stale fallback routing metadata for provider '${providerLabel}'. ` +
            'Mandatory reviews do not permit same_agent_fallback.'
        );
    }
}

export function assertReviewContextContractOrThrow(options: {
    taskId: string;
    reviewType: string;
    contextPath: string;
    reviewContext: Record<string, unknown> | null;
    preflightPath: string;
    preflightSha256: string | null;
    preflightPayload?: Record<string, unknown> | null;
    requireStrictBindingMetadata?: boolean;
}): void {
    const diffExpectations = buildReviewContextPreflightDiffExpectations(options.preflightPayload, options.reviewType);
    const requireStrictBindingMetadata = options.requireStrictBindingMetadata === true
        || diffExpectations.expectedRequiredReview;
    const violations = getReviewContextContractViolations({
        contextPath: options.contextPath,
        reviewContext: options.reviewContext,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedPreflightPath: options.preflightPath,
        expectedPreflightSha256: options.preflightSha256,
        requireReviewType: true,
        requireTaskId: requireStrictBindingMetadata,
        requirePreflightPath: requireStrictBindingMetadata,
        requirePreflightSha256: requireStrictBindingMetadata,
        ...diffExpectations
    });
    if (violations.length > 0) {
        throw new Error(violations.join(' '));
    }
}

export function assertExplicitReviewContextRuntimeIdentity(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    contextPath: string;
    reviewerRouting: Record<string, unknown> | null;
    taskModePath?: string | null;
}): ReturnType<typeof resolveRuntimeReviewerIdentity> {
    const runtimeIdentity = resolveRuntimeReviewerIdentity({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        taskModePath: String(options.taskModePath || '').trim(),
        allowLegacyFallback: true
    });
    if (runtimeIdentity.identity_status !== 'resolved') {
        throw new Error(
            `Review '${options.reviewType}' cannot be recorded because runtime reviewer identity is ` +
            `'${runtimeIdentity.identity_status}'.`
        );
    }
    if (runtimeIdentity.violations.length > 0) {
        throw new Error(runtimeIdentity.violations.join(' '));
    }
    const resolvedRoutingIdentity = resolveReviewContextRoutingIdentity({
        reviewerRouting: options.reviewerRouting,
        canonicalSourceOfTruth: runtimeIdentity.canonical_source_of_truth,
        executionProvider: runtimeIdentity.execution_provider,
        allowLegacyCompatibility: runtimeIdentity.task_mode_identity_backfilled
    });
    const reviewContextExecutionProviderSource = normalizeRuntimeIdentitySource(options.reviewerRouting?.execution_provider_source);
    if (!runtimeIdentity.canonical_source_of_truth) {
        throw new Error(
            `Review '${options.reviewType}' cannot be recorded because the active workspace is missing canonical SourceOfTruth.`
        );
    }
    if (!resolvedRoutingIdentity.canonical_source_of_truth) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing canonical_source_of_truth in ${normalizePath(options.contextPath)}.`
        );
    }
    if (resolvedRoutingIdentity.canonical_source_of_truth !== runtimeIdentity.canonical_source_of_truth) {
        throw new Error(
            `Review '${options.reviewType}' review-context canonical_source_of_truth ` +
            `(${resolvedRoutingIdentity.canonical_source_of_truth}) does not match canonical provider ` +
            `(${runtimeIdentity.canonical_source_of_truth}).`
        );
    }
    if (!runtimeIdentity.execution_provider) {
        throw new Error(
            `Review '${options.reviewType}' cannot be recorded because the active task is missing execution provider identity.`
        );
    }
    if (!resolvedRoutingIdentity.execution_provider) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing execution_provider in ${normalizePath(options.contextPath)}.`
        );
    }
    if (resolvedRoutingIdentity.execution_provider !== runtimeIdentity.execution_provider) {
        throw new Error(
            `Review '${options.reviewType}' review-context execution_provider ` +
            `(${resolvedRoutingIdentity.execution_provider}) does not match active runtime provider ` +
            `(${runtimeIdentity.execution_provider}).`
        );
    }
    if (resolvedRoutingIdentity.explicit_split_identity_present && !reviewContextExecutionProviderSource) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing execution_provider_source in ${normalizePath(options.contextPath)}.`
        );
    }
    if (
        resolvedRoutingIdentity.explicit_split_identity_present
        && runtimeIdentity.execution_provider_source
        && reviewContextExecutionProviderSource !== runtimeIdentity.execution_provider_source
    ) {
        throw new Error(
            `Review '${options.reviewType}' review-context execution_provider_source ` +
            `(${reviewContextExecutionProviderSource}) does not match active runtime source ` +
            `(${runtimeIdentity.execution_provider_source}).`
        );
    }
    if (!resolvedRoutingIdentity.identity_status) {
        throw new Error(
            `Review '${options.reviewType}' review-context is missing identity_status in ${normalizePath(options.contextPath)}.`
        );
    }
    if (resolvedRoutingIdentity.identity_status !== 'resolved') {
        throw new Error(
            `Review '${options.reviewType}' review-context runtime identity status must be 'resolved', ` +
            `got '${resolvedRoutingIdentity.identity_status}'.`
        );
    }
    return runtimeIdentity;
}

function assertReviewContextRuntimeIdentityMetadataPresent(options: {
    reviewType: string;
    contextPath: string;
    reviewContext: Record<string, unknown> | null;
    reviewerRouting: Record<string, unknown> | null;
}): void {
    if (!options.reviewerRouting) {
        return;
    }
    const handoff = options.reviewContext?.reviewer_handoff;
    if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) {
        return;
    }
    const routing = options.reviewerRouting;
    const violations: string[] = [];
    if (routing.canonical_source_of_truth == null || String(routing.canonical_source_of_truth).trim() === '') {
        violations.push(`Review '${options.reviewType}' review-context is missing canonical_source_of_truth in ${normalizePath(options.contextPath)}.`);
    }
    if (routing.execution_provider == null || String(routing.execution_provider).trim() === '') {
        violations.push(`Review '${options.reviewType}' review-context is missing execution_provider in ${normalizePath(options.contextPath)}.`);
    }
    if (routing.identity_status == null || String(routing.identity_status).trim() === '') {
        violations.push(`Review '${options.reviewType}' review-context is missing identity_status in ${normalizePath(options.contextPath)}.`);
    }
    if (violations.length > 0) {
        throw new Error(violations.join(' '));
    }
}

function matchesRoutingEvent(
    entry: ReviewDependencyTimelineEvent,
    reviewType: string,
    reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>,
    reviewerIdentity: string,
    reviewerFallbackReason: string | null
): boolean {
    const details = entry.details;
    return entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
        && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === reviewType
        && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === reviewerExecutionMode
        && String((details?.reviewer_session_id ?? details?.reviewerSessionId) || '').trim() === reviewerIdentity
        && !reviewerFallbackReason;
}

function findLatestTimelineSequence(
    events: readonly ReviewDependencyTimelineEvent[],
    predicate: (entry: ReviewDependencyTimelineEvent) => boolean
): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) {
            return events[index].sequence;
        }
    }
    return null;
}

export function findMatchingRoutingEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string,
    reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>,
    reviewerIdentity: string,
    reviewerFallbackReason: string | null
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    const latestReviewPhaseSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => (
            entry.event_type === 'REVIEW_PHASE_STARTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
        )
    );
    const cycleFloorSequence = latestCompilePassSequence == null
        ? latestReviewPhaseSequence
        : latestReviewPhaseSequence == null
            ? latestCompilePassSequence
            : Math.max(latestCompilePassSequence, latestReviewPhaseSequence);
    if (cycleFloorSequence == null) {
        return null;
    }
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        if (entry.sequence <= cycleFloorSequence) {
            break;
        }
        if (
            entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && matchesRoutingEvent(
                entry,
                normalizedReviewType,
                reviewerExecutionMode,
                reviewerIdentity,
                reviewerFallbackReason
            )
        ) {
            return entry;
        }
    }
    return null;
}

function resolveReviewCycleFloorSequence(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string
): number | null {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    const latestReviewPhaseSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => (
            entry.event_type === 'REVIEW_PHASE_STARTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
        )
    );
    if (latestCompilePassSequence == null) {
        return latestReviewPhaseSequence;
    }
    if (latestReviewPhaseSequence == null) {
        return latestCompilePassSequence;
    }
    return Math.max(latestCompilePassSequence, latestReviewPhaseSequence);
}

export function assertNoCurrentCycleReviewRecordedBeforeRouting(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string
): void {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const cycleFloorSequence = resolveReviewCycleFloorSequence(timelineEvents, normalizedReviewType);
    if (cycleFloorSequence == null) {
        return;
    }
    const recordedReview = [...timelineEvents].reverse().find((entry) => (
        entry.sequence > cycleFloorSequence
        && entry.event_type === 'REVIEW_RECORDED'
        && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
    ));
    if (!recordedReview) {
        return;
    }
    throw new Error(
        `Review routing for '${normalizedReviewType}' is locked because current-cycle REVIEW_RECORDED telemetry already exists. ` +
        'Do not record a new REVIEWER_DELEGATION_ROUTED event after a review result has been recorded for the same review type. ' +
        'If a fresh reviewer is required, run restart-review-cycle or restart-coherent-cycle first so downstream review evidence is explicitly invalidated; this does not require a full task reset.'
    );
}

function findMatchingReviewerInvocationAttestationEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>;
        reviewerIdentity: string;
        reviewContextSha256: string;
        reviewTreeStateSha256?: string | null;
        routingEventSha256: string;
    }
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(options.reviewType || '').trim().toLowerCase();
    const normalizedTaskId = String(options.taskId || '').trim();
    const normalizedReviewContextSha256 = String(options.reviewContextSha256 || '').trim().toLowerCase();
    const normalizedReviewTreeStateSha256 = String(options.reviewTreeStateSha256 || '').trim().toLowerCase();
    const normalizedRoutingEventSha256 = String(options.routingEventSha256 || '').trim().toLowerCase();
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        const details = entry.details;
        const detailsTaskId = String(details?.task_id || details?.taskId || '').trim();
        const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewTreeStateSha256 = String(details?.review_tree_state_sha256 || details?.reviewTreeStateSha256 || '')
            .trim()
            .toLowerCase();
        const detailsRoutingEventSha256 = String(details?.routing_event_sha256 || details?.routingEventSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewerIdentity = String(
            (details?.reviewer_session_id ?? details?.reviewerSessionId ?? details?.reviewer_identity ?? details?.reviewerIdentity) || ''
        ).trim();
        if (
            entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
            && (!detailsTaskId || detailsTaskId === normalizedTaskId)
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === options.reviewerExecutionMode
            && detailsReviewerIdentity === options.reviewerIdentity
            && detailsReviewContextSha256 === normalizedReviewContextSha256
            && (!normalizedReviewTreeStateSha256 || detailsReviewTreeStateSha256 === normalizedReviewTreeStateSha256)
            && detailsRoutingEventSha256 === normalizedRoutingEventSha256
            && entry.integrity
        ) {
            return entry;
        }
    }
    return null;
}

export function findMatchingReviewerLaunchPreparedEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>;
        reviewerIdentity: string;
        reviewContextSha256: string;
        routingEventSha256: string;
        launchBindingSha256: string;
        preparedLaunchEventSha256: string;
        minSequenceExclusive: number;
    }
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(options.reviewType || '').trim().toLowerCase();
    const normalizedTaskId = String(options.taskId || '').trim();
    const normalizedReviewContextSha256 = String(options.reviewContextSha256 || '').trim().toLowerCase();
    const normalizedRoutingEventSha256 = String(options.routingEventSha256 || '').trim().toLowerCase();
    const normalizedLaunchBindingSha256 = String(options.launchBindingSha256 || '').trim().toLowerCase();
    const normalizedPreparedLaunchEventSha256 = String(options.preparedLaunchEventSha256 || '').trim().toLowerCase();
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        const details = entry.details;
        const detailsTaskId = String(details?.task_id || details?.taskId || '').trim();
        const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
            .trim()
            .toLowerCase();
        const detailsRoutingEventSha256 = String(details?.routing_event_sha256 || details?.routingEventSha256 || '')
            .trim()
            .toLowerCase();
        const detailsLaunchBindingSha256 = String(details?.launch_binding_sha256 || details?.launchBindingSha256 || '')
            .trim()
            .toLowerCase();
        const detailsReviewerIdentity = String(
            (details?.reviewer_session_id ?? details?.reviewerSessionId ?? details?.reviewer_identity ?? details?.reviewerIdentity) || ''
        ).trim();
        if (
            entry.event_type === 'REVIEWER_LAUNCH_PREPARED'
            && entry.sequence > options.minSequenceExclusive
            && (!detailsTaskId || detailsTaskId === normalizedTaskId)
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === options.reviewerExecutionMode
            && detailsReviewerIdentity === options.reviewerIdentity
            && detailsReviewContextSha256 === normalizedReviewContextSha256
            && detailsRoutingEventSha256 === normalizedRoutingEventSha256
            && detailsLaunchBindingSha256 === normalizedLaunchBindingSha256
            && entry.integrity?.event_sha256 === normalizedPreparedLaunchEventSha256
        ) {
            return entry;
        }
    }
    return null;
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

export function snapshotSupersededReviewerLaunchArtifact(options: {
    artifactPath: string;
    mismatches: string[];
}): SupersededReviewerLaunchArtifactSnapshot {
    const artifactSha256 = fileSha256(options.artifactPath);
    if (!artifactSha256) {
        throw new Error(`Reviewer launch artifact could not be hashed before supersession: ${normalizePath(options.artifactPath)}.`);
    }
    const parsedPath = path.parse(options.artifactPath);
    const snapshotPath = path.join(
        parsedPath.dir,
        `${parsedPath.name}-superseded-${artifactSha256}${parsedPath.ext || '.json'}`
    );
    if (!fs.existsSync(snapshotPath)) {
        fs.copyFileSync(options.artifactPath, snapshotPath);
    }
    const mismatches = options.mismatches.length > 0
        ? options.mismatches
        : ['existing reviewer launch artifact is not current for this preparation'];
    return {
        artifact_path: normalizePath(options.artifactPath),
        artifact_sha256: artifactSha256,
        snapshot_path: normalizePath(snapshotPath),
        superseded_reason: mismatches.join('; '),
        mismatches
    };
}

export function getCurrentPreparedReviewerLaunchMismatches(options: {
    artifactPath: string;
    artifact: Record<string, unknown>;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256: string | null;
    rolePromptSha256?: string | null;
    promptTemplateSha256?: string | null;
    outputTemplateSha256?: string | null;
    evidenceManifestSha256?: string | null;
    reviewOutputPath?: string | null;
    copyPasteReviewerLaunchPrompt?: string | null;
    copyPasteReviewerLaunchPromptSha256?: string | null;
    reviewTreeStateSha256: string | null;
    launchBindingSha256: string;
    routingEventSequence: number;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
}): string[] {
    const evidenceType = getStringField(options.artifact, 'evidence_type', 'artifact_type');
    const attestationState = getStringField(options.artifact, 'attestation_state', 'attestationState');
    const preparedLaunchEventSha256 = getStringField(
        options.artifact,
        'prepared_launch_event_sha256',
        'preparedLaunchEventSha256'
    ).toLowerCase();
    const mismatches = getReviewerLaunchArtifactMismatchReasons(options.artifact, {
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        reviewerPromptSha256: options.reviewerPromptSha256,
        rolePromptSha256: options.rolePromptSha256,
        promptTemplateSha256: options.promptTemplateSha256,
        outputTemplateSha256: options.outputTemplateSha256,
        evidenceManifestSha256: options.evidenceManifestSha256,
        reviewOutputPath: options.reviewOutputPath,
        copyPasteReviewerLaunchPrompt: options.copyPasteReviewerLaunchPrompt,
        copyPasteReviewerLaunchPromptSha256: options.copyPasteReviewerLaunchPromptSha256,
        reviewTreeStateSha256: options.reviewTreeStateSha256,
        launchBindingSha256: options.launchBindingSha256,
        preparedLaunchEventSha256,
        routingEventSequence: options.routingEventSequence,
        timelineEvents: options.timelineEvents
    });
    if (Number(options.artifact.schema_version) !== 1) {
        mismatches.push('schema_version mismatch');
    }
    if (evidenceType !== PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE) {
        mismatches.push('evidence_type mismatch');
    }
    if (attestationState !== 'prepared') {
        mismatches.push('attestation_state mismatch');
    }
    if (getStringField(options.artifact, 'attestation_source', 'attestationSource', 'source') !== PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE) {
        mismatches.push('attestation_source mismatch');
    }
    if (!preparedLaunchEventSha256) {
        mismatches.push('prepared_launch_event_sha256 missing');
    }
    const expectedLaunchInputArtifactPath = resolveReviewerLaunchInputArtifactPath(options.artifactPath);
    const actualLaunchInputArtifactPath = getStringField(
        options.artifact,
        'reviewer_launch_input_artifact_path',
        'reviewerLaunchInputArtifactPath'
    );
    if (actualLaunchInputArtifactPath !== normalizePath(expectedLaunchInputArtifactPath)) {
        mismatches.push('reviewer_launch_input_artifact_path mismatch');
    } else if (!fs.existsSync(expectedLaunchInputArtifactPath) || !fs.statSync(expectedLaunchInputArtifactPath).isFile()) {
        mismatches.push('reviewer launch input artifact missing');
    } else {
        const artifactSha256 = fileSha256(options.artifactPath) || '';
        const launchInputArtifactSha256 = fileSha256(expectedLaunchInputArtifactPath) || '';
        if (!artifactSha256 || launchInputArtifactSha256 !== artifactSha256) {
            mismatches.push('reviewer launch input artifact sha256 mismatch');
        }
    }
    return mismatches;
}

export function isCurrentCompletedReviewerLaunchArtifact(options: {
    repoRoot: string;
    artifactPath: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256: string | null;
    rolePromptSha256?: string | null;
    promptTemplateSha256?: string | null;
    outputTemplateSha256?: string | null;
    evidenceManifestSha256?: string | null;
    reviewTreeStateSha256: string | null;
    routingEventSequence: number;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
}): boolean {
    try {
        validateReviewerLaunchArtifact({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            reviewerPromptSha256: options.reviewerPromptSha256,
            rolePromptSha256: options.rolePromptSha256,
            promptTemplateSha256: options.promptTemplateSha256,
            outputTemplateSha256: options.outputTemplateSha256,
            evidenceManifestSha256: options.evidenceManifestSha256,
            reviewTreeStateSha256: options.reviewTreeStateSha256,
            routingEventSequence: options.routingEventSequence,
            timelineEvents: options.timelineEvents,
            artifactPathValue: options.artifactPath
        });
        return true;
    } catch {
        return false;
    }
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

export function assertPreparedReviewerLaunchArtifact(options: {
    artifactPath: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256?: string | null;
    rolePromptSha256?: string | null;
    promptTemplateSha256?: string | null;
    outputTemplateSha256?: string | null;
    evidenceManifestSha256?: string | null;
    reviewOutputPath?: string | null;
    reviewerLaunchInputArtifactPath?: string | null;
    copyPasteReviewerLaunchPrompt?: string | null;
    copyPasteReviewerLaunchPromptSha256?: string | null;
    reviewTreeStateSha256?: string | null;
}): void {
    const artifact = readJsonFile(options.artifactPath, 'Prepared reviewer launch artifact');
    const launchBindingSha256 = getStringField(artifact, 'launch_binding_sha256', 'launchBindingSha256').toLowerCase();
    const expectedLaunchBindingSha256 = options.reviewerPromptSha256
        ? buildReviewerLaunchBindingSha256({
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            reviewerPromptSha256: options.reviewerPromptSha256
        })
        : '';
    const violations: string[] = [];
    if (Number(artifact.schema_version) !== 1) {
        violations.push('schema_version must be 1');
    }
    if (getStringField(artifact, 'evidence_type', 'artifact_type') !== PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE) {
        violations.push(`evidence_type must be '${PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE}'`);
    }
    if (getStringField(artifact, 'attestation_state', 'attestationState') !== 'prepared') {
        violations.push("attestation_state must be 'prepared'");
    }
    if (getStringField(artifact, 'task_id', 'taskId') !== options.taskId) {
        violations.push(`task_id must be '${options.taskId}'`);
    }
    if (getStringField(artifact, 'review_type', 'reviewType').toLowerCase() !== options.reviewType) {
        violations.push(`review_type must be '${options.reviewType}'`);
    }
    if (getStringField(artifact, 'reviewer_execution_mode', 'reviewerExecutionMode') !== options.reviewerExecutionMode) {
        violations.push(`reviewer_execution_mode must be '${options.reviewerExecutionMode}'`);
    }
    if (getStringField(artifact, 'reviewer_identity', 'reviewerIdentity', 'reviewer_session_id', 'reviewerSessionId') !== options.reviewerIdentity) {
        violations.push(`reviewer_identity must be '${options.reviewerIdentity}'`);
    }
    if (getStringField(artifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase() !== options.reviewContextSha256) {
        violations.push('review_context_sha256 must match the current review context');
    }
    if (getStringField(artifact, 'routing_event_sha256', 'routingEventSha256').toLowerCase() !== options.routingEventSha256) {
        violations.push('routing_event_sha256 must match the current routing event');
    }
    if (options.reviewerPromptSha256) {
        const actualPromptSha256 = getStringField(
            artifact,
            'reviewer_prompt_sha256',
            'reviewerPromptSha256'
        ).toLowerCase();
        if (actualPromptSha256 !== options.reviewerPromptSha256) {
            violations.push('reviewer_prompt_sha256 must match the current review context prompt artifact');
        }
    }
    if (options.rolePromptSha256) {
        const actualRolePromptSha256 = getStringField(artifact, 'role_prompt_sha256', 'rolePromptSha256').toLowerCase();
        if (actualRolePromptSha256 !== options.rolePromptSha256) {
            violations.push('role_prompt_sha256 must match the current review context role prompt artifact');
        }
    }
    if (options.promptTemplateSha256) {
        const actualPromptTemplateSha256 = getStringField(artifact, 'prompt_template_sha256', 'promptTemplateSha256').toLowerCase();
        if (actualPromptTemplateSha256 !== options.promptTemplateSha256) {
            violations.push('prompt_template_sha256 must match the current review context prompt template artifact');
        }
    }
    if (options.outputTemplateSha256) {
        const actualOutputTemplateSha256 = getStringField(artifact, 'output_template_sha256', 'outputTemplateSha256').toLowerCase();
        if (actualOutputTemplateSha256 !== options.outputTemplateSha256) {
            violations.push('output_template_sha256 must match the current review context output template artifact');
        }
    }
    if (options.evidenceManifestSha256) {
        const actualEvidenceManifestSha256 = getStringField(artifact, 'evidence_manifest_sha256', 'evidenceManifestSha256').toLowerCase();
        if (actualEvidenceManifestSha256 !== options.evidenceManifestSha256) {
            violations.push('evidence_manifest_sha256 must match the current review context evidence manifest artifact');
        }
    }
    if (options.reviewOutputPath) {
        const actualReviewOutputPath = getStringField(artifact, 'review_output_path', 'reviewOutputPath');
        if (actualReviewOutputPath !== normalizePath(options.reviewOutputPath)) {
            violations.push('review_output_path must match the prepared reviewer output path');
        }
    }
    if (options.reviewerLaunchInputArtifactPath) {
        const actualInputArtifactPath = getStringField(
            artifact,
            'reviewer_launch_input_artifact_path',
            'reviewerLaunchInputArtifactPath'
        );
        if (actualInputArtifactPath !== normalizePath(options.reviewerLaunchInputArtifactPath)) {
            violations.push('reviewer_launch_input_artifact_path must match the immutable reviewer launch input artifact path');
        }
    }
    if (options.copyPasteReviewerLaunchPrompt) {
        const actualCopyPastePrompt = getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt',
            'copyPasteReviewerLaunchPrompt'
        );
        if (actualCopyPastePrompt !== options.copyPasteReviewerLaunchPrompt) {
            violations.push('copy_paste_reviewer_launch_prompt must match the prepared reviewer launch prompt');
        }
        const actualCopyPastePromptSha256 = getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt_sha256',
            'copyPasteReviewerLaunchPromptSha256'
        ).toLowerCase();
        const expectedCopyPastePromptSha256 = options.copyPasteReviewerLaunchPromptSha256
            || stringSha256(options.copyPasteReviewerLaunchPrompt);
        if (!actualCopyPastePromptSha256) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 is required');
        } else if (actualCopyPastePromptSha256 !== expectedCopyPastePromptSha256) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 must match the prepared reviewer launch prompt');
        }
    } else {
        const actualCopyPastePrompt = getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt',
            'copyPasteReviewerLaunchPrompt'
        );
        const actualCopyPastePromptSha256 = getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt_sha256',
            'copyPasteReviewerLaunchPromptSha256'
        ).toLowerCase();
        if (actualCopyPastePrompt && !actualCopyPastePromptSha256) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 is required when copy_paste_reviewer_launch_prompt is present');
        } else if (
            actualCopyPastePrompt
            && actualCopyPastePromptSha256
            && actualCopyPastePromptSha256 !== stringSha256(actualCopyPastePrompt)
        ) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 must match copy_paste_reviewer_launch_prompt');
        }
    }
    if (options.reviewTreeStateSha256) {
        const actualTreeStateSha256 = getStringField(
            artifact,
            'review_tree_state_sha256',
            'reviewTreeStateSha256'
        ).toLowerCase();
        if (actualTreeStateSha256 !== options.reviewTreeStateSha256) {
            violations.push('review_tree_state_sha256 must match the current review context tree_state');
        }
    }
    if (getStringField(artifact, 'attestation_source', 'attestationSource', 'source') !== PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE) {
        violations.push(`attestation_source must be '${PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE}'`);
    }
    if (!launchBindingSha256) {
        violations.push('launch_binding_sha256 is required');
    } else if (expectedLaunchBindingSha256 && launchBindingSha256 !== expectedLaunchBindingSha256) {
        violations.push('launch_binding_sha256 must match the current prepared launch binding');
    }
    if (!getStringField(artifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256')) {
        violations.push('prepared_launch_event_sha256 is required');
    }
    if (violations.length > 0) {
        throw new Error(
            'Prepared reviewer launch artifact failed validation:\n' +
            violations.map((violation) => `- ${violation}`).join('\n')
        );
    }
}

async function recordReviewReceiptFromArtifacts(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    artifactPath: string;
    contextPath: string;
    rawReviewOutputPath?: string | null;
    rawReviewOutputSha256?: string | null;
    rawReviewOutputSourceMtimeUtc?: string | null;
    reviewMaterializationFidelity?: string | null;
    taskModePath?: string | null;
    reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>;
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
    requireStrictBindingMetadata?: boolean;
}): Promise<string> {
    if (!fs.existsSync(options.artifactPath) || !fs.statSync(options.artifactPath).isFile()) {
        throw new Error(`Review artifact not found: ${options.artifactPath}`);
    }

    const preflight = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8'));
    const preflightSha256 = fileSha256(options.preflightPath);
    const artifactSha256 = fileSha256(options.artifactPath);
    const parsedReviewContext = JSON.parse(fs.readFileSync(options.contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewContextContractOrThrow({
        taskId: options.taskId,
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        reviewContext: parsedReviewContext,
        preflightPath: options.preflightPath,
        preflightSha256,
        preflightPayload: preflight as Record<string, unknown>,
        requireStrictBindingMetadata: options.requireStrictBindingMetadata
    });
    assertReviewTreeStateFresh({
        repoRoot: options.repoRoot,
        reviewContext: parsedReviewContext,
        contextPath: options.contextPath,
        gateName: 'record-review-receipt'
    });
    resolveReviewerPromptArtifactBinding({
        repoRoot: options.repoRoot,
        contextPath: options.contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-review-receipt'
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = assertExplicitReviewContextRuntimeIdentity({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertRoutingCompatibility({
        reviewType: options.reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerFallbackReason: options.reviewerFallbackReason
    });
    assertReviewReceiptRoutingMatchesContext({
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        currentRouting,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.reviewerFallbackReason
    });

    const timelinePath = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingEvent = findMatchingRoutingEvent(
        timelineEvents,
        options.reviewType,
        options.reviewerExecutionMode,
        options.reviewerIdentity,
        options.reviewerFallbackReason
    );
    if (!routingEvent) {
        throw new Error(
            `Review receipts require pre-recorded REVIEWER_DELEGATION_ROUTED telemetry for '${options.reviewType}' ` +
            'in the current cycle ' +
            `with reviewer '${options.reviewerIdentity}' and execution mode '${options.reviewerExecutionMode}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Review receipts require controller-attested reviewer_provenance for delegated_subagent '${options.reviewType}' reviews. ` +
            'Matching routing telemetry is missing event integrity.'
        );
    }

    const contextSha256 = fileSha256(options.contextPath);
    if (!contextSha256) {
        throw new Error(`Review receipts require a hashable review-context artifact: ${normalizePath(options.contextPath)}.`);
    }
    const invocationEvent = findMatchingReviewerInvocationAttestationEvent(timelineEvents, {
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256: getReviewTreeStateSha256(parsedReviewContext) || null,
        routingEventSha256: routingEventProvenance.event_sha256
    });
    const reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
        invocationEvent?.event_type || '',
        invocationEvent?.integrity,
        invocationEvent?.details
    );
    if (options.reviewerExecutionMode === 'delegated_subagent' && !reviewerProvenance) {
        throw new Error(
            `Review receipts require REVIEWER_INVOCATION_ATTESTED launch provenance for delegated_subagent '${options.reviewType}' reviews. ` +
            'Run the real delegated reviewer launch path before recording reviewer output; local routing telemetry alone is not enough.'
        );
    }
    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight as Record<string, unknown>, options.repoRoot);
    const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(
        options.reviewType,
        preflight as Record<string, unknown>,
        options.repoRoot
    );
    const receipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256,
        scopeSha256: preflight.metrics?.scope_sha256 || preflight.metrics?.changed_files_sha256 || null,
        reviewScopeSha256: reviewScopeFingerprint.review_scope_sha256,
        codeScopeSha256: isNonTestReviewScope(options.reviewType)
            ? codeScopeFingerprint.code_scope_sha256
            : null,
        domainScopeFingerprints: buildDomainScopeFingerprints({
            repoRoot: options.repoRoot,
            detectionSource: String(preflight.detection_source || 'git_auto'),
            includeUntracked: preflight.include_untracked !== false,
            changedFiles: Array.isArray(preflight.changed_files) ? preflight.changed_files as string[] : []
        }),
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256: getReviewTreeStateSha256(parsedReviewContext) || null,
        reviewContextReuseSha256: computeReviewContextReuseHash(parsedReviewContext),
        reviewArtifactSha256: artifactSha256,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.reviewerFallbackReason,
        reviewerProvenance,
        trustLevel: 'INDEPENDENT_AUDITED'
    });
    (receipt as unknown as Record<string, unknown>).review_result_recorded_at_utc =
        (receipt as unknown as Record<string, unknown>).recorded_at_utc ?? new Date().toISOString();
    (receipt as unknown as Record<string, unknown>).review_output_path = options.rawReviewOutputPath
        ? normalizePath(options.rawReviewOutputPath)
        : null;
    (receipt as unknown as Record<string, unknown>).review_output_sha256 = options.rawReviewOutputSha256 || null;
    (receipt as unknown as Record<string, unknown>).review_output_source_mtime_utc =
        options.rawReviewOutputSourceMtimeUtc || null;
    (receipt as unknown as Record<string, unknown>).review_materialization_fidelity = options.reviewMaterializationFidelity || 'exact';

    const receiptPayloadSha256 = createHash('sha256')
        .update(`${JSON.stringify(receipt, null, 2)}\n`)
        .digest('hex');
    return writeReviewReceiptSnapshotsAndTelemetry({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        artifactPath: options.artifactPath,
        contextPath: options.contextPath,
        receipt: receipt as unknown as Record<string, unknown>,
        receiptPayloadSha256,
        artifactSha256
    });
}

async function writeReviewReceiptSnapshotsAndTelemetry(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    artifactPath: string;
    contextPath: string;
    receipt: Record<string, unknown>;
    receiptPayloadSha256: string;
    artifactSha256: string | null;
}): Promise<string> {
    const receiptPath = options.artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptSnapshotPath = options.artifactPath.replace(/\.md$/, `-receipt-${options.receiptPayloadSha256}.json`);
    const artifactSnapshotPath = options.artifactPath.replace(/\.md$/, `-artifact-${options.artifactSha256}.md`);

    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');
    await writeReviewArtifactsWithRollback([
        {
            artifactPath: receiptPath,
            contentType: 'json',
            payload: options.receipt
        },
        {
            artifactPath: receiptSnapshotPath,
            contentType: 'json',
            payload: options.receipt
        },
        {
            artifactPath: artifactSnapshotPath,
            contentType: 'text',
            content: fs.readFileSync(options.artifactPath, 'utf8')
        }
    ], async () => {
        const recordedEvent = await emitReviewRecordedEventAsync(orchestratorRoot, options.taskId, options.reviewType, {
            ...options.receipt,
            receipt_path: normalizePath(receiptPath),
            receipt_sha256: options.receiptPayloadSha256,
            receipt_snapshot_path: normalizePath(receiptSnapshotPath),
            receipt_snapshot_sha256: options.receiptPayloadSha256,
            review_artifact_path: normalizePath(options.artifactPath),
            review_artifact_snapshot_path: normalizePath(artifactSnapshotPath),
            review_artifact_snapshot_sha256: options.artifactSha256,
            review_context_path: normalizePath(options.contextPath)
        });
        if (!recordedEvent || taskEventAppendHasBlockingFailure(recordedEvent, false)) {
            throw new Error(
                `Review receipts require REVIEW_RECORDED telemetry for '${options.reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
    });
    return receiptPath;
}

const reviewInvocationHandlers = createReviewInvocationHandlers({
    assertExplicitReviewContextRuntimeIdentity,
    assertReviewContextContractOrThrow,
    assertRoutingCompatibility,
    buildReviewerLaunchBindingSha256,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingReviewerLaunchPreparedEvent,
    findMatchingRoutingEvent,
    getReviewTreeStateSha256,
    getStringField,
    isForbiddenReviewerLaunchAttestationSource,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    parseReviewerIdentity,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    readJsonFile,
    resolveCanonicalPreflightArtifactPath,
    resolveReviewerHandoffBindings,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    stringSha256
});

export const {
    handleRecordReviewInvocation,
    validateReviewerLaunchArtifact
} = reviewInvocationHandlers;

const reviewRoutingLaunchHandlers = createReviewRoutingLaunchHandlers({
    assertExplicitReviewContextRuntimeIdentity,
    assertNoCurrentCycleReviewRecordedBeforeRouting,
    assertPreparedReviewerLaunchArtifact,
    assertReviewContextContractOrThrow,
    assertRoutingCompatibility,
    buildCopyPasteReviewerLaunchPrompt,
    buildRecordReviewInvocationCommand,
    buildReviewerLaunchBindingSha256,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingRoutingEvent,
    getCurrentPreparedReviewerLaunchMismatches,
    getReviewTreeStateLaunchSummary,
    getReviewTreeStateSha256,
    getReviewerScopedDiffHandoffPaths,
    getStringField,
    handleRecordReviewInvocation,
    isCurrentCompletedReviewerLaunchArtifact,
    isForbiddenReviewerLaunchAttestationSource,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    normalizeReviewerLaunchAttestationSource,
    parseReviewerIdentity,
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    printCopyPasteReviewerLaunchPrompt,
    readJsonFile,
    readJsonObjectIfPresent,
    resolveCanonicalPreflightArtifactPath,
    resolveProviderLaunchMetadata,
    resolveReviewerHandoffBindings,
    resolveReviewerDraftOutputPath,
    resolveReviewerLaunchArtifactPathForWrite,
    resolveReviewerLaunchInputArtifactPath,
    resolveReviewerLaunchInputAttestation,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    snapshotSupersededReviewerLaunchArtifact,
    stringSha256,
    toReviewerHandoffAbsolutePath
});

export const {
    handleRecordReviewRouting,
    handlePrepareReviewerLaunch,
    handleCompleteReviewerLaunch
} = reviewRoutingLaunchHandlers;

export async function handleRecordReviewResult(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--review-output-path': { key: 'reviewOutputPath', type: 'string' },
        '--review-output-stdin': { key: 'reviewOutputStdin', type: 'boolean' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-result', 'review_phase');
    const { preflightPath, artifactPath, contextPath } = resolveCanonicalReviewPaths(
        repoRoot,
        taskId,
        reviewType,
        options.preflightPath,
        options.reviewContextPath
    );
    const reviewOutput = await resolveReviewOutputInput(
        options,
        repoRoot,
        path.dirname(preflightPath),
        taskId,
        reviewType,
        readReviewOutputFromStdin
    );
    const rawReviewOutputSha256 = fileSha256(reviewOutput.reviewOutputPath);
    let reviewContent = reviewOutput.reviewContent;
    let reviewMaterializationFidelity = 'exact';
    const expectedPassVerdict = REVIEW_CONTRACTS.find(([candidate]) => candidate === reviewType)?.[1] || null;
    if (!expectedPassVerdict) {
        throw new Error(`Unsupported review type '${reviewType}' for record-review-result.`);
    }
    const expectedFailVerdict = expectedPassVerdict.replace(/\bPASSED\b/, 'FAILED');
    const verdictTokenSet = buildReviewVerdictTokenSet(reviewType, expectedPassVerdict, expectedFailVerdict);
    const verdictToken = extractReviewVerdictToken(reviewContent, expectedPassVerdict, expectedFailVerdict, reviewType);
    if (!verdictToken) {
        const passExample = verdictTokenSet.canonicalPassToken || expectedPassVerdict;
        const failExample = verdictTokenSet.canonicalFailToken || expectedFailVerdict;
        throw new Error(
            `Review output must contain a recognized verdict token for '${reviewType}'. ` +
            formatAcceptedReviewVerdictTokens(verdictTokenSet) +
            ` The token must appear as a standalone line inside the reviewer output file (--review-output-path), not as a CLI flag. ` +
            `Example PASS line: '${passExample}'. Example FAIL line: '${failExample}'. ` +
            `Do not pass '--verdict pass' or similar flags; place the token on its own line under a '## Verdict' heading in the review output file.\n\n` +
            buildMinimalPassReviewTemplateHint(reviewType, passExample)
        );
    }
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        preflightPayload,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    assertReviewContextRuntimeIdentityMetadataPresent({
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        reviewerRouting: currentRouting
    });
    if (reviewType === 'test') {
        assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload,
            reviewType,
            timelineEvents: readDependencyTimelineEvents(timelinePath),
            taskModePath: String(options.taskModePath || '').trim()
        });
    }
    if (parsedReviewContext.tree_state != null) {
        assertReviewTreeStateFresh({
            repoRoot,
            reviewContext: parsedReviewContext,
            contextPath,
            gateName: 'record-review-result'
        });
    }

    const materializedReview = materializeReviewContent({
        artifactPath,
        reviewType,
        reviewContent,
        verdictToken,
        expectedPassVerdict,
        requirePassValidationNotes: reviewContextRequiresPassValidationNotes(contextPath, repoRoot),
        analyze: analyzeEarlyReviewMaterialization,
        normalizeHeadings: normalizeCanonicalReviewSectionHeadings,
        buildLosslessPassReviewNormalization,
        isLosslessPassNormalizationEligibleViolation,
        buildPassReviewTemplateHintMessage
    });
    reviewContent = materializedReview.reviewContent;
    reviewMaterializationFidelity = materializedReview.reviewMaterializationFidelity;
    if (reviewType !== 'test') {
        assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload,
            reviewType,
            timelineEvents: readDependencyTimelineEvents(timelinePath),
            taskModePath: String(options.taskModePath || '').trim()
        });
    }
    assertReviewTreeStateFresh({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'record-review-result'
    });
    resolveReviewerPromptArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-review-result'
    });
    const runtimeIdentity = assertExplicitReviewContextRuntimeIdentity({
        repoRoot,
        taskId,
        reviewType,
        contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertRoutingCompatibility({
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    });

    const artifactRollbackState = captureReviewArtifactRollbackState(artifactPath);
    const previousRoutingUpdate = {
        actualExecutionMode: currentRouting?.actual_execution_mode != null
            ? String(currentRouting.actual_execution_mode).trim() || null
            : null,
        reviewerSessionId: currentRouting?.reviewer_session_id != null
            ? String(currentRouting.reviewer_session_id).trim() || null
            : null,
        fallbackReason: currentRouting?.fallback_reason != null
            ? String(currentRouting.fallback_reason).trim() || null
            : null
    };
    writeReviewArtifactText(artifactPath, reviewContent.endsWith('\n') ? reviewContent : `${reviewContent}\n`);
    const routingUpdate = applyReviewerRoutingMetadata(contextPath, {
        actualExecutionMode: reviewerExecutionMode,
        reviewerSessionId: reviewerIdentity,
        fallbackReason: reviewerFallbackReason
    });

    try {
        const receiptPath = await recordReviewReceiptFromArtifacts({
            repoRoot,
            taskId,
            reviewType,
            preflightPath,
            artifactPath,
            contextPath,
            rawReviewOutputPath: reviewOutput.reviewOutputPath,
            rawReviewOutputSha256,
            rawReviewOutputSourceMtimeUtc: reviewOutput.reviewOutputSourceMtimeUtc,
            reviewMaterializationFidelity,
            taskModePath: String(options.taskModePath || '').trim(),
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerFallbackReason,
            requireStrictBindingMetadata: !!options.reviewContextPath
        });
        cleanupReviewTempSourceArtifact(repoRoot, taskId, reviewOutput.reviewOutputSourcePath);

        console.log(`REVIEW_RESULT_RECORDED: ${reviewType}`);
        console.log(`ArtifactPath: ${normalizePath(artifactPath)}`);
        console.log(`ContextPath: ${normalizePath(contextPath)}`);
        console.log(`ReceiptPath: ${normalizePath(receiptPath)}`);
        console.log(`ReviewerExecutionMode: ${reviewerExecutionMode}`);
        console.log(`ReviewerIdentity: ${reviewerIdentity}`);
        console.log(`ReviewOutputMode: ${reviewOutput.reviewOutputMode}`);
        console.log(`ReviewOutputPath: ${normalizePath(reviewOutput.reviewOutputPath)}`);
        console.log(`ReviewOutputSha256: ${rawReviewOutputSha256 || 'n/a'}`);
        console.log(`ReviewMaterializationFidelity: ${reviewMaterializationFidelity}`);
        if (reviewOutput.reviewOutputSourcePath) {
            console.log(`ReviewOutputSourcePath: ${normalizePath(reviewOutput.reviewOutputSourcePath)}`);
        }
        console.log(`ContextSha256: ${routingUpdate.contextSha256 || 'n/a'}`);
        if (reviewerFallbackReason) {
            console.log(`ReviewerFallbackReason: ${reviewerFallbackReason}`);
        }
        console.log(`VerdictToken: ${verdictToken}`);
        console.log(`ReviewerCleanup: ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`);
    } catch (error: unknown) {
        try {
            restoreReviewerRoutingMetadata(contextPath, previousRoutingUpdate);
        } catch {
            // Best-effort rollback only.
        }
        try {
            restoreReviewArtifactFromRollbackState(artifactPath, artifactRollbackState, { ensureTrailingNewline: true });
        } catch {
            // Best-effort rollback only.
        }
        throw error;
    }
}

export async function handleRecordReviewReceipt(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-receipt', 'review_phase');
    const { preflightPath, artifactPath, contextPath } = resolveCanonicalReviewPaths(
        repoRoot,
        taskId,
        reviewType,
        options.preflightPath,
        options.reviewContextPath
    );
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents: readDependencyTimelineEvents(timelinePath),
        taskModePath: String(options.taskModePath || '').trim()
    });
    const receiptPath = await recordReviewReceiptFromArtifacts({
        repoRoot,
        taskId,
        reviewType,
        preflightPath,
        artifactPath,
        contextPath,
        rawReviewOutputPath: artifactPath,
        rawReviewOutputSha256: fileSha256(artifactPath),
        rawReviewOutputSourceMtimeUtc: fs.statSync(artifactPath).mtime.toISOString(),
        taskModePath: String(options.taskModePath || '').trim(),
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    console.log(`REVIEW_RECORDED: ${reviewType} (Receipt: ${normalizePath(receiptPath)})`);
    console.log(`ReviewerCleanup: ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`);
}
