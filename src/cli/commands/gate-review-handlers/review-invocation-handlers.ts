import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildReviewReceiptReviewerProvenance,
    normalizeCompatibilityReviewerExecutionMode
} from '../../../gate-runtime/review-context';
import {
    assertValidTaskId,
    taskEventAppendHasBlockingFailure
} from '../../../gate-runtime/task-events';
import { fileSha256 } from '../../../gate-runtime/hash';
import {
    emitReviewerInvocationAttestedEventAsync
} from '../../../gate-runtime/lifecycle-events';
import * as gateHelpers from '../../../gates/helpers';
import { normalizePath } from '../../../gates/helpers';
import { resolveCanonicalReviewContextPath } from '../../../gates/review-context-paths';
import { assertReviewTreeStateFresh } from '../../../gates/review-tree-state';
import { resolveReviewerPromptArtifactBinding } from '../../../gates/review-prompt-artifact';
import { assertReviewLifecycleGuard } from '../../../gates/review-lifecycle-guard';
import {
    parseOptions,
    normalizePathValue
} from '../cli-helpers';
import {
    type ParsedOptionsRecord
} from '../shared-command-utils';
import {
    isTaskOwnedReviewTempPath
} from '../gates-artifacts';
import {
    readDependencyTimelineEvents
} from './review-dependency-timeline';

type ReviewerLaunchInputMode = 'copy_paste_prompt' | 'launch_artifact_path';

interface ReviewerLaunchArtifactValidationResult {
    artifactPath: string;
    artifactSha256: string;
    attestationSource: string;
    launchTool: string;
    providerInvocationId: string;
    launchPreparedAtUtc: string | null;
    launchedAtUtc: string;
    launchCompletedAtUtc: string | null;
    launchInputMode: ReviewerLaunchInputMode | null;
    launchInputSha256: string | null;
    copyPasteReviewerLaunchPromptSha256: string | null;
}

const REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT: ReviewerLaunchInputMode = 'copy_paste_prompt';
const REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH: ReviewerLaunchInputMode = 'launch_artifact_path';
const REVIEWER_LAUNCH_INPUT_MODES = new Set<ReviewerLaunchInputMode>([
    REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT,
    REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH
]);
const UTC_ISO_8601_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

export interface ReviewInvocationHandlerDependencies {
    assertExplicitReviewContextRuntimeIdentity: typeof import('./index').assertExplicitReviewContextRuntimeIdentity;
    assertReviewContextContractOrThrow: typeof import('./index').assertReviewContextContractOrThrow;
    assertRoutingCompatibility: typeof import('./index').assertRoutingCompatibility;
    buildReviewerLaunchBindingSha256: typeof import('./index').buildReviewerLaunchBindingSha256;
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('./index').COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    findMatchingReviewerLaunchPreparedEvent: typeof import('./index').findMatchingReviewerLaunchPreparedEvent;
    findMatchingRoutingEvent: typeof import('./index').findMatchingRoutingEvent;
    getReviewTreeStateSha256: typeof import('./index').getReviewTreeStateSha256;
    getStringField: typeof import('./index').getStringField;
    isForbiddenReviewerLaunchAttestationSource: typeof import('./index').isForbiddenReviewerLaunchAttestationSource;
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY: typeof import('./index').LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY;
    parseReviewerIdentity: typeof import('./index').parseReviewerIdentity;
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('./index').PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    readJsonFile: typeof import('./index').readJsonFile;
    resolveCanonicalPreflightArtifactPath: typeof import('./index').resolveCanonicalPreflightArtifactPath;
    resolveReviewerHandoffBindings: typeof import('./index').resolveReviewerHandoffBindings;
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS: typeof import('./index').REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS;
    stringSha256: typeof import('./index').stringSha256;
}

export function createReviewInvocationHandlers(deps: ReviewInvocationHandlerDependencies) {
    const {
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
    } = deps;

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

    function validateReviewerLaunchArtifact(options: {
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
        timelineEvents: readonly import('../../../gates/review-dependencies').ReviewDependencyTimelineEvent[];
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
            violations.push("schema_version must be 1");
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
                        const actualLaunchInputArtifactSha256 = fileSha256(resolvedLaunchInputArtifactPath) || '';
                        if (!actualLaunchInputArtifactSha256) {
                            violations.push('ReviewerLaunchInputArtifactPath must be hashable');
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
        if (!launchedAtUtc) {
            violations.push('launched_at_utc is required');
        } else if (!isValidUtcIso8601Timestamp(launchedAtUtc)) {
            violations.push('launched_at_utc must be a valid UTC ISO-8601 timestamp');
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
            launchedAtUtc,
            launchCompletedAtUtc,
            launchInputMode: launchInputMode || null,
            launchInputSha256: launchInputSha256 || null,
            copyPasteReviewerLaunchPromptSha256: copyPastePromptSha256 || null
        };
    }

    async function handleRecordReviewInvocation(gateArgv: string[]): Promise<void> {
        const defs = {
            '--task-id': { key: 'taskId', type: 'string' },
            '--review-type': { key: 'reviewType', type: 'string' },
            '--review-context-path': { key: 'reviewContextPath', type: 'string' },
            '--task-mode-path': { key: 'taskModePath', type: 'string' },
            '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
            '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
            '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
            '--reviewer-launch-artifact-path': { key: 'reviewerLaunchArtifactPath', type: 'string' },
            '--repo-root': { key: 'repoRoot', type: 'string' }
        };
        const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
        const options = rawOptions as ParsedOptionsRecord;
        const taskId = assertValidTaskId(options.taskId);
        const reviewType = String(options.reviewType || '').trim().toLowerCase();
        if (!reviewType) throw new Error('ReviewType is required.');

        const repoRoot = normalizePathValue(options.repoRoot || '.');
        assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-invocation', 'review_phase');
        const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
        const reviewsRoot = path.dirname(preflightPath);
        const contextPath = resolveCanonicalReviewContextPath({
            reviewsRoot,
            taskId,
            reviewType,
            explicitPath: options.reviewContextPath ? String(options.reviewContextPath) : '',
            repoRoot
        });
        if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
            throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
        }
        const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
            options,
            "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
        );
        const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
        const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const preflightSha256 = fileSha256(preflightPath);
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
        assertReviewTreeStateFresh({
            repoRoot,
            reviewContext: parsedReviewContext,
            contextPath,
            gateName: 'record-review-invocation'
        });
        const promptBinding = resolveReviewerPromptArtifactBinding({
            repoRoot,
            contextPath,
            reviewContext: parsedReviewContext,
            gateName: 'record-review-invocation'
        });
        const handoffBindings = resolveReviewerHandoffBindings({
            repoRoot,
            contextPath,
            reviewContext: parsedReviewContext,
            gateName: 'record-review-invocation'
        });
        const currentRouting = parsedReviewContext.reviewer_routing
            && typeof parsedReviewContext.reviewer_routing === 'object'
            && !Array.isArray(parsedReviewContext.reviewer_routing)
            ? parsedReviewContext.reviewer_routing as Record<string, unknown>
            : null;
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

        const currentExecutionMode = normalizeCompatibilityReviewerExecutionMode(currentRouting?.actual_execution_mode);
        const currentReviewerSessionId = currentRouting?.reviewer_session_id != null
            ? String(currentRouting.reviewer_session_id).trim()
            : '';
        if (currentExecutionMode !== reviewerExecutionMode || currentReviewerSessionId !== reviewerIdentity) {
            throw new Error(
                `Reviewer invocation attestation requires review-context routing metadata for '${reviewType}' ` +
                `to match reviewer '${reviewerIdentity}' and execution mode '${reviewerExecutionMode}'.`
            );
        }

        const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
        const timelineEvents = readDependencyTimelineEvents(timelinePath);
        const routingEvent = findMatchingRoutingEvent(
            timelineEvents,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerFallbackReason
        );
        if (!routingEvent) {
            throw new Error(
                `Reviewer invocation attestation requires current-cycle REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}' ` +
                `and reviewer '${reviewerIdentity}'.`
            );
        }
        const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
        if (!routingEventProvenance) {
            throw new Error(
                `Reviewer invocation attestation requires integrity-backed REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'.`
            );
        }
        const contextSha256 = fileSha256(contextPath);
        if (!contextSha256) {
            throw new Error(`Reviewer invocation attestation requires a hashable review-context artifact: ${normalizePath(contextPath)}.`);
        }
        const launchArtifact = validateReviewerLaunchArtifact({
            repoRoot,
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewContextSha256: contextSha256,
            routingEventSha256: routingEventProvenance.event_sha256,
            reviewerPromptSha256: promptBinding.reviewerPromptSha256,
            rolePromptSha256: handoffBindings.rolePromptSha256,
            promptTemplateSha256: handoffBindings.promptTemplateSha256,
            outputTemplateSha256: handoffBindings.outputTemplateSha256,
            evidenceManifestSha256: handoffBindings.evidenceManifestSha256,
            reviewTreeStateSha256: getReviewTreeStateSha256(parsedReviewContext),
            routingEventSequence: routingEvent.sequence,
            timelineEvents,
            artifactPathValue: options.reviewerLaunchArtifactPath
        });
        const invocationAttestedAtUtc = new Date().toISOString();
        const invocationEvent = await emitReviewerInvocationAttestedEventAsync(
            gateHelpers.joinOrchestratorPath(repoRoot, ''),
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            contextSha256,
            routingEventProvenance.event_sha256,
            {
                launchDetails: {
                    reviewer_launch_artifact_path: normalizePath(launchArtifact.artifactPath),
                    reviewer_launch_artifact_sha256: launchArtifact.artifactSha256,
                    execution_provider: runtimeIdentity.execution_provider,
                    execution_provider_source: runtimeIdentity.execution_provider_source,
                    canonical_source_of_truth: runtimeIdentity.canonical_source_of_truth,
                    routed_to: runtimeIdentity.routed_to,
                    provider_bridge: runtimeIdentity.provider_bridge,
                    reviewer_launch_attestation_source: launchArtifact.attestationSource,
                    reviewer_launch_tool: launchArtifact.launchTool,
                    provider_invocation_id: launchArtifact.providerInvocationId,
                    launch_input_mode: launchArtifact.launchInputMode,
                    launch_input_sha256: launchArtifact.launchInputSha256,
                    copy_paste_reviewer_launch_prompt_sha256: launchArtifact.copyPasteReviewerLaunchPromptSha256,
                    launch_prepared_at_utc: launchArtifact.launchPreparedAtUtc,
                    launched_at_utc: launchArtifact.launchedAtUtc,
                    launch_completed_at_utc: launchArtifact.launchCompletedAtUtc,
                    invocation_attested_at_utc: invocationAttestedAtUtc,
                    review_tree_state_sha256: getReviewTreeStateSha256(parsedReviewContext) || null
                }
            }
        );
        if (!invocationEvent || taskEventAppendHasBlockingFailure(invocationEvent, false)) {
            throw new Error(
                `Reviewer invocation attestation requires REVIEWER_INVOCATION_ATTESTED telemetry for '${reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
        console.log(`REVIEWER_INVOCATION_ATTESTED: ${reviewType}`);
        console.log(`ReviewerIdentity: ${reviewerIdentity}`);
        console.log(`LaunchArtifactPath: ${normalizePath(launchArtifact.artifactPath)}`);
        console.log(`LaunchArtifactSha256: ${launchArtifact.artifactSha256}`);
    }

    return {
        handleRecordReviewInvocation,
        validateReviewerLaunchArtifact
    };
}
