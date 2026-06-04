import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    fileSha256,
    gateHelpers,
    normalizeCompatibilityReviewerExecutionMode,
    normalizePath,
    type ReviewDependencyTimelineEvent
} from './review-launch-entrypoints';
import {
    isTaskOwnedReviewTempPath
} from '../../gates-artifacts';
import {
    buildReviewerLaunchBindingSha256,
    resolveReviewerLaunchInputArtifactPath,
    stringSha256
} from './review-launch-input-attestation';

type ReviewerLaunchInputMode = 'copy_paste_prompt' | 'launch_artifact_path';

export interface ReviewerLaunchArtifactValidationResult {
    artifactPath: string;
    artifactSha256: string;
    attestationSource: string;
    launchTool: string;
    providerInvocationId: string;
    launchPreparedAtUtc: string | null;
    delegationStartedAtUtc: string | null;
    launchedAtUtc: string;
    launchCompletedAtUtc: string | null;
    launchInputMode: ReviewerLaunchInputMode | null;
    launchInputSha256: string | null;
    copyPasteReviewerLaunchPromptSha256: string | null;
}

export interface SupersededReviewerLaunchArtifactSnapshot {
    artifact_path: string;
    artifact_sha256: string;
    snapshot_path: string;
    superseded_reason: string;
    mismatches: string[];
}

export const PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch_preparation';
export const COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch';
export const PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE = 'garda_prepare_reviewer_launch';
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
    'delegation_started_at_utc=<gate-owned UTC timestamp recorded by record-reviewer-delegation-started>',
    'launched_at_utc=<same reviewer delegation start timestamp for compatibility>',
    'launch_input_mode=copy_paste_prompt or launch_artifact_path',
    'launch_input_sha256=<sha256 of exact CopyPasteReviewerLaunchPrompt or ReviewerLaunchInputArtifactPath>',
    'fresh_context=true, isolated_context=true, or fork_context=false'
]);

const REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT: ReviewerLaunchInputMode = 'copy_paste_prompt';
const REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH: ReviewerLaunchInputMode = 'launch_artifact_path';
const REVIEWER_LAUNCH_INPUT_MODES = new Set<ReviewerLaunchInputMode>([
    REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT,
    REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH
]);
const UTC_ISO_8601_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

export function normalizeReviewerLaunchAttestationSource(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

export function isForbiddenReviewerLaunchAttestationSource(value: string): boolean {
    return FORBIDDEN_COMPLETED_REVIEWER_LAUNCH_ATTESTATION_SOURCES.has(
        normalizeReviewerLaunchAttestationSource(value)
    );
}

function getStringField(record: Record<string, unknown>, ...keys: string[]): string {
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

function readJsonFile(pathValue: string, label: string): Record<string, unknown> {
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

function normalizeReviewerLaunchInputMode(value: unknown): ReviewerLaunchInputMode | null {
    const normalized = String(value || '').trim().toLowerCase();
    return REVIEWER_LAUNCH_INPUT_MODES.has(normalized as ReviewerLaunchInputMode)
        ? normalized as ReviewerLaunchInputMode
        : null;
}

function isValidUtcIso8601Timestamp(value: string): boolean {
    const match = UTC_ISO_8601_TIMESTAMP_PATTERN.exec(value);
    if (!match) {
        return false;
    }
    const timestampMs = Date.parse(value);
    if (!Number.isFinite(timestampMs)) {
        return false;
    }
    const parsed = new Date(timestampMs);
    const [, year, month, day, hour, minute, second] = match.map(Number);
    return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() + 1 === month
        && parsed.getUTCDate() === day
        && parsed.getUTCHours() === hour
        && parsed.getUTCMinutes() === minute
        && parsed.getUTCSeconds() === second;
}

function buildReviewerLaunchCompletionHint(): string {
    return [
        'Completion hint:',
        '- Start from the prepared reviewer-launch artifact; do not search for or recompute its hashes.',
        '- Attest the exact launch input: copy_paste_prompt uses CopyPasteReviewerLaunchPromptSha256; launch_artifact_path uses ReviewerLaunchInputArtifactPath and its prepared artifact sha256.',
        `- Required completed-launch updates: ${REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS.join('; ')}.`,
        `- Trust boundary: ${LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY}`
    ].join('\n');
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

export function findMatchingReviewerLaunchPreparedEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: 'delegated_subagent';
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
        const pinnedInputArtifactSha256 = getStringField(
            options.artifact,
            'reviewer_launch_input_artifact_sha256',
            'reviewerLaunchInputArtifactSha256'
        ).toLowerCase();
        const launchInputArtifactSha256 = fileSha256(expectedLaunchInputArtifactPath) || '';
        if (!launchInputArtifactSha256) {
            mismatches.push('reviewer launch input artifact could not be hashed');
        } else if (!/^[0-9a-f]{64}$/.test(pinnedInputArtifactSha256)) {
            mismatches.push('reviewer_launch_input_artifact_sha256 missing');
        } else if (launchInputArtifactSha256 !== pinnedInputArtifactSha256) {
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
    reviewerLaunchInputArtifactSha256?: string | null;
    copyPasteReviewerLaunchPrompt?: string | null;
    copyPasteReviewerLaunchPromptSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    allowedAttestationStates?: readonly string[];
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
    const allowedAttestationStates = options.allowedAttestationStates || ['prepared'];
    const attestationState = getStringField(artifact, 'attestation_state', 'attestationState');
    if (!allowedAttestationStates.includes(attestationState)) {
        violations.push(`attestation_state must be one of: ${allowedAttestationStates.join(', ')}`);
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
        if (options.reviewerLaunchInputArtifactSha256) {
            const actualInputArtifactSha256 = getStringField(
                artifact,
                'reviewer_launch_input_artifact_sha256',
                'reviewerLaunchInputArtifactSha256'
            ).toLowerCase();
            if (actualInputArtifactSha256 !== options.reviewerLaunchInputArtifactSha256.toLowerCase()) {
                violations.push('reviewer_launch_input_artifact_sha256 must match the immutable reviewer launch input artifact hash');
            }
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
    const attestationSource = getStringField(artifact, 'attestation_source', 'attestationSource', 'source');
    if (attestationState === 'prepared' && attestationSource !== PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE) {
        violations.push(`attestation_source must be '${PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE}'`);
    } else if (attestationState === 'delegation_started' && !attestationSource) {
        violations.push('attestation_source is required for delegation_started launch artifact');
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

export function validateReviewerLaunchArtifact(options: {
    repoRoot: string;
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
    reviewTreeStateSha256?: string | null;
    routingEventSequence: number;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    artifactPathValue: unknown;
}): ReviewerLaunchArtifactValidationResult {
    const rawArtifactPath = String(options.artifactPathValue || '').trim();
    if (!rawArtifactPath) {
        throw new Error('ReviewerLaunchArtifactPath is required.');
    }
    const artifactPath = gateHelpers.resolvePathInsideRepo(rawArtifactPath, options.repoRoot, { allowMissing: true });
    if (!artifactPath || !fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        throw new Error(`Reviewer launch artifact not found: ${normalizePath(rawArtifactPath)}.`);
    }
    if (!isTaskOwnedReviewTempPath(options.repoRoot, options.taskId, artifactPath)) {
        throw new Error(
            `ReviewerLaunchArtifactPath must be task-owned under reviewer scratch storage for '${options.taskId}'. ` +
            `Got ${normalizePath(artifactPath)}.`
        );
    }

    const artifact = readJsonFile(artifactPath, 'ReviewerLaunchArtifactPath');
    const schemaVersion = Number(artifact.schema_version);
    const evidenceType = String(artifact.evidence_type || artifact.artifact_type || '').trim();
    const attestationState = getStringField(artifact, 'attestation_state', 'attestationState');
    const reviewType = String(artifact.review_type || artifact.reviewType || '').trim().toLowerCase();
    const taskId = String(artifact.task_id || artifact.taskId || '').trim();
    const reviewerExecutionMode = String(
        artifact.reviewer_execution_mode || artifact.reviewerExecutionMode || ''
    ).trim();
    const reviewerIdentity = String(
        artifact.reviewer_identity || artifact.reviewerIdentity || artifact.reviewer_session_id || artifact.reviewerSessionId || ''
    ).trim();
    const reviewContextSha256 = String(
        artifact.review_context_sha256 || artifact.reviewContextSha256 || ''
    ).trim().toLowerCase();
    const routingEventSha256 = String(
        artifact.routing_event_sha256 || artifact.routingEventSha256 || ''
    ).trim().toLowerCase();
    const attestationSource = String(
        artifact.attestation_source || artifact.attestationSource || artifact.source || ''
    ).trim().toLowerCase();
    const launchTool = String(artifact.launch_tool || artifact.launchTool || '').trim();
    const providerInvocationId = getStringField(
        artifact,
        'provider_invocation_id',
        'providerInvocationId',
        'controller_invocation_id',
        'controllerInvocationId'
    );
    const launchPreparedAtUtc = getStringField(artifact, 'launch_prepared_at_utc', 'launchPreparedAtUtc') || null;
    const delegationStartedAtUtc = getStringField(
        artifact,
        'delegation_started_at_utc',
        'delegationStartedAtUtc'
    ) || null;
    const launchedAtUtc = getStringField(artifact, 'launched_at_utc', 'launchedAtUtc');
    const launchCompletedAtUtc = getStringField(artifact, 'launch_completed_at_utc', 'launchCompletedAtUtc') || null;
    const preparedLaunchEventSha256 = getStringField(
        artifact,
        'prepared_launch_event_sha256',
        'preparedLaunchEventSha256'
    ).toLowerCase();
    const reviewerPromptSha256 = getStringField(artifact, 'reviewer_prompt_sha256', 'reviewerPromptSha256').toLowerCase();
    const rolePromptSha256 = getStringField(artifact, 'role_prompt_sha256', 'rolePromptSha256').toLowerCase();
    const promptTemplateSha256 = getStringField(artifact, 'prompt_template_sha256', 'promptTemplateSha256').toLowerCase();
    const outputTemplateSha256 = getStringField(artifact, 'output_template_sha256', 'outputTemplateSha256').toLowerCase();
    const evidenceManifestSha256 = getStringField(artifact, 'evidence_manifest_sha256', 'evidenceManifestSha256').toLowerCase();
    const launchBindingSha256 = getStringField(artifact, 'launch_binding_sha256', 'launchBindingSha256').toLowerCase();
    const copyPastePrompt = getStringField(
        artifact,
        'copy_paste_reviewer_launch_prompt',
        'copyPasteReviewerLaunchPrompt'
    );
    const copyPastePromptSha256 = getStringField(
        artifact,
        'copy_paste_reviewer_launch_prompt_sha256',
        'copyPasteReviewerLaunchPromptSha256'
    ).toLowerCase();
    const launchInputMode = normalizeReviewerLaunchInputMode(getStringField(artifact, 'launch_input_mode', 'launchInputMode'));
    const rawLaunchInputMode = getStringField(artifact, 'launch_input_mode', 'launchInputMode');
    const launchInputSha256 = getStringField(artifact, 'launch_input_sha256', 'launchInputSha256').toLowerCase();
    const launchInputArtifactPath = getStringField(artifact, 'launch_input_artifact_path', 'launchInputArtifactPath');
    const reviewerLaunchInputArtifactPath = getStringField(
        artifact,
        'reviewer_launch_input_artifact_path',
        'reviewerLaunchInputArtifactPath'
    );
    const launchInputArtifactSha256 = getStringField(artifact, 'launch_input_artifact_sha256', 'launchInputArtifactSha256').toLowerCase();
    const preparedReviewerLaunchArtifactSha256 = getStringField(
        artifact,
        'prepared_reviewer_launch_artifact_sha256',
        'preparedReviewerLaunchArtifactSha256'
    ).toLowerCase();
    const reviewTreeStateSha256 = getStringField(
        artifact,
        'review_tree_state_sha256',
        'reviewTreeStateSha256'
    ).toLowerCase();
    const expectedLaunchBindingSha256 = buildReviewerLaunchBindingSha256({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        reviewerPromptSha256: options.reviewerPromptSha256 || reviewerPromptSha256 || null
    });
    const freshContext = artifact.fresh_context === true
        || artifact.freshContext === true
        || artifact.isolated_context === true
        || artifact.isolatedContext === true
        || artifact.fork_context === false
        || artifact.forkContext === false;
    const violations: string[] = [];
    if (schemaVersion !== 1) {
        violations.push('schema_version must be 1');
    }
    if (evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE || attestationState === 'prepared') {
        violations.push(
            'prepared reviewer launch metadata cannot satisfy REVIEWER_INVOCATION_ATTESTED; ' +
            'launch a real delegated reviewer and persist provider/controller invocation evidence first'
        );
    }
    if (evidenceType !== COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE) {
        violations.push(`evidence_type must be '${COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE}'`);
    }
    if (attestationState !== 'launched') {
        violations.push("attestation_state must be 'launched'");
    }
    if (taskId !== options.taskId) {
        violations.push(`task_id must be '${options.taskId}'`);
    }
    if (reviewType !== options.reviewType) {
        violations.push(`review_type must be '${options.reviewType}'`);
    }
    if (reviewerExecutionMode !== options.reviewerExecutionMode) {
        violations.push(`reviewer_execution_mode must be '${options.reviewerExecutionMode}'`);
    }
    if (reviewerIdentity !== options.reviewerIdentity) {
        violations.push(`reviewer_identity must be '${options.reviewerIdentity}'`);
    }
    if (reviewContextSha256 !== options.reviewContextSha256) {
        violations.push('review_context_sha256 must match the current review context');
    }
    if (routingEventSha256 !== options.routingEventSha256) {
        violations.push('routing_event_sha256 must match the current routing event');
    }
    if (options.reviewerPromptSha256 && reviewerPromptSha256 !== options.reviewerPromptSha256) {
        violations.push('reviewer_prompt_sha256 must match the current review context prompt artifact');
    }
    if (options.rolePromptSha256 && rolePromptSha256 !== options.rolePromptSha256) {
        violations.push('role_prompt_sha256 must match the current review context role prompt artifact');
    }
    if (options.promptTemplateSha256 && promptTemplateSha256 !== options.promptTemplateSha256) {
        violations.push('prompt_template_sha256 must match the current review context prompt template artifact');
    }
    if (options.outputTemplateSha256 && outputTemplateSha256 !== options.outputTemplateSha256) {
        violations.push('output_template_sha256 must match the current review context output template artifact');
    }
    if (options.evidenceManifestSha256 && evidenceManifestSha256 !== options.evidenceManifestSha256) {
        violations.push('evidence_manifest_sha256 must match the current review context evidence manifest artifact');
    }
    const launchInputFidelityRequired = evidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
        || attestationState === 'launched'
        || Boolean(
            copyPastePrompt
            || copyPastePromptSha256
            || rawLaunchInputMode
            || launchInputSha256
            || launchInputArtifactPath
            || launchInputArtifactSha256
            || preparedReviewerLaunchArtifactSha256
        );
    if (launchInputFidelityRequired) {
        if (!copyPastePrompt) {
            violations.push('copy_paste_reviewer_launch_prompt is required for launch input fidelity');
        }
        if (!copyPastePromptSha256) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 is required');
        } else if (!/^[0-9a-f]{64}$/.test(copyPastePromptSha256)) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 must be a lowercase sha256 hex digest');
        } else if (copyPastePrompt && copyPastePromptSha256 !== stringSha256(copyPastePrompt)) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 must match copy_paste_reviewer_launch_prompt');
        }
        if (!rawLaunchInputMode) {
            violations.push('launch_input_mode is required');
        } else if (!launchInputMode) {
            violations.push(
                `launch_input_mode must be '${REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT}' ` +
                `or '${REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH}'`
            );
        }
        if (!launchInputSha256) {
            violations.push('launch_input_sha256 is required');
        } else if (!/^[0-9a-f]{64}$/.test(launchInputSha256)) {
            violations.push('launch_input_sha256 must be a lowercase sha256 hex digest');
        } else if (
            launchInputMode === REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT
            && copyPastePromptSha256
            && launchInputSha256 !== copyPastePromptSha256
        ) {
            violations.push('launch_input_sha256 must match copy_paste_reviewer_launch_prompt_sha256 for copy_paste_prompt mode');
        } else if (launchInputMode === REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH) {
            if (!launchInputArtifactPath) {
                violations.push('launch_input_artifact_path is required for launch_artifact_path mode');
            } else {
                const resolvedLaunchInputArtifactPath = gateHelpers.resolvePathInsideRepo(
                    launchInputArtifactPath,
                    options.repoRoot,
                    { allowMissing: true }
                );
                const resolvedReviewerLaunchInputArtifactPath = reviewerLaunchInputArtifactPath
                    ? gateHelpers.resolvePathInsideRepo(
                        reviewerLaunchInputArtifactPath,
                        options.repoRoot,
                        { allowMissing: true }
                    )
                    : null;
                const normalizedResolvedLaunchInputArtifactPath = resolvedLaunchInputArtifactPath
                    ? normalizePath(resolvedLaunchInputArtifactPath).toLowerCase()
                    : '';
                const normalizedReviewerLaunchInputArtifactPath = resolvedReviewerLaunchInputArtifactPath
                    ? normalizePath(resolvedReviewerLaunchInputArtifactPath).toLowerCase()
                    : '';
                if (
                    !resolvedLaunchInputArtifactPath
                    || (
                        normalizedResolvedLaunchInputArtifactPath !== normalizePath(artifactPath).toLowerCase()
                        && normalizedResolvedLaunchInputArtifactPath !== normalizedReviewerLaunchInputArtifactPath
                    )
                ) {
                    violations.push('launch_input_artifact_path must match ReviewerLaunchInputArtifactPath or ReviewerLaunchArtifactPath');
                } else if (
                    normalizedReviewerLaunchInputArtifactPath
                    && normalizedResolvedLaunchInputArtifactPath === normalizedReviewerLaunchInputArtifactPath
                ) {
                    const pinnedInputArtifactSha256 = getStringField(
                        artifact,
                        'reviewer_launch_input_artifact_sha256',
                        'reviewerLaunchInputArtifactSha256'
                    ).toLowerCase();
                    const actualLaunchInputArtifactSha256 = fileSha256(resolvedLaunchInputArtifactPath) || '';
                    if (!actualLaunchInputArtifactSha256) {
                        violations.push('ReviewerLaunchInputArtifactPath must be hashable');
                    } else if (!pinnedInputArtifactSha256 || !/^[0-9a-f]{64}$/.test(pinnedInputArtifactSha256)) {
                        violations.push('reviewer_launch_input_artifact_sha256 is required for ReviewerLaunchInputArtifactPath attestation');
                    } else if (actualLaunchInputArtifactSha256 !== pinnedInputArtifactSha256) {
                        violations.push('ReviewerLaunchInputArtifactPath contents must match the immutable prepare-time handoff hash');
                    } else if (launchInputArtifactSha256 && actualLaunchInputArtifactSha256 !== launchInputArtifactSha256) {
                        violations.push('launch_input_artifact_sha256 must match ReviewerLaunchInputArtifactPath contents');
                    }
                }
            }
            if (!launchInputArtifactSha256) {
                violations.push('launch_input_artifact_sha256 is required for launch_artifact_path mode');
            }
            if (!preparedReviewerLaunchArtifactSha256) {
                violations.push('prepared_reviewer_launch_artifact_sha256 is required for launch_artifact_path mode');
            }
            if (
                launchInputArtifactSha256
                && preparedReviewerLaunchArtifactSha256
                && launchInputArtifactSha256 !== preparedReviewerLaunchArtifactSha256
            ) {
                violations.push('launch_input_artifact_sha256 must match prepared_reviewer_launch_artifact_sha256');
            }
            if (
                launchInputSha256
                && preparedReviewerLaunchArtifactSha256
                && launchInputSha256 !== preparedReviewerLaunchArtifactSha256
            ) {
                violations.push('launch_input_sha256 must match prepared_reviewer_launch_artifact_sha256 for launch_artifact_path mode');
            }
        }
    }
    if (options.reviewTreeStateSha256 && reviewTreeStateSha256 !== options.reviewTreeStateSha256) {
        violations.push('review_tree_state_sha256 must match the current review context tree_state');
    }
    if (!launchBindingSha256) {
        violations.push('launch_binding_sha256 is required');
    } else if (launchBindingSha256 !== expectedLaunchBindingSha256) {
        violations.push('launch_binding_sha256 must match the current prepared launch binding');
    }
    if (!preparedLaunchEventSha256) {
        violations.push('prepared_launch_event_sha256 is required');
    } else if (!/^[0-9a-f]{64}$/.test(preparedLaunchEventSha256)) {
        violations.push('prepared_launch_event_sha256 must be a lowercase sha256 hex digest');
    } else if (
        !findMatchingReviewerLaunchPreparedEvent(options.timelineEvents, {
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            launchBindingSha256: expectedLaunchBindingSha256,
            preparedLaunchEventSha256,
            minSequenceExclusive: options.routingEventSequence
        })
    ) {
        violations.push('prepared_launch_event_sha256 must reference current REVIEWER_LAUNCH_PREPARED telemetry');
    }
    if (!freshContext) {
        violations.push('fresh_context, isolated_context, or fork_context=false must attest clean reviewer context');
    }
    if (!attestationSource) {
        violations.push('attestation_source is required');
    } else if (isForbiddenReviewerLaunchAttestationSource(attestationSource)) {
        violations.push('attestation_source must be provider/controller-owned completed launch evidence');
    }
    if (!launchTool) {
        violations.push('launch_tool is required');
    }
    if (!providerInvocationId) {
        violations.push('provider_invocation_id or controller_invocation_id is required');
    }
    if (delegationStartedAtUtc && !isValidUtcIso8601Timestamp(delegationStartedAtUtc)) {
        violations.push('delegation_started_at_utc must be a valid UTC ISO-8601 timestamp');
    }
    if (!launchedAtUtc) {
        violations.push('launched_at_utc is required');
    } else if (!isValidUtcIso8601Timestamp(launchedAtUtc)) {
        violations.push('launched_at_utc must be a valid UTC ISO-8601 timestamp');
    } else if (delegationStartedAtUtc && launchedAtUtc !== delegationStartedAtUtc) {
        violations.push('launched_at_utc must match delegation_started_at_utc for compatibility');
    }
    if (launchPreparedAtUtc && !isValidUtcIso8601Timestamp(launchPreparedAtUtc)) {
        violations.push('launch_prepared_at_utc must be a valid UTC ISO-8601 timestamp');
    }
    if (launchCompletedAtUtc && !isValidUtcIso8601Timestamp(launchCompletedAtUtc)) {
        violations.push('launch_completed_at_utc must be a valid UTC ISO-8601 timestamp');
    }
    if (violations.length > 0) {
        throw new Error(
            'Reviewer launch artifact is not eligible for invocation attestation:\n' +
            violations.map((violation) => `- ${violation}`).join('\n') +
            '\n\n' +
            buildReviewerLaunchCompletionHint()
        );
    }

    return {
        artifactPath,
        artifactSha256: fileSha256(artifactPath) || '',
        attestationSource,
        launchTool,
        providerInvocationId,
        launchPreparedAtUtc,
        delegationStartedAtUtc,
        launchedAtUtc,
        launchCompletedAtUtc,
        launchInputMode: launchInputMode || null,
        launchInputSha256: launchInputSha256 || null,
        copyPasteReviewerLaunchPromptSha256: copyPastePromptSha256 || null
    };
}
