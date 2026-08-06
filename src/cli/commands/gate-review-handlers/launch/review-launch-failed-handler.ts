import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    assertReviewLifecycleGuard,
    assertValidTaskId,
    emitReviewerLaunchFailedEventAsync,
    fileSha256,
    gateHelpers,
    normalizePath,
    resolveCanonicalReviewContextPath,
    taskEventAppendHasBlockingFailure,
    writeReviewArtifactJson
} from './review-launch-entrypoints';
import { parseOptions, normalizePathValue } from '../../cli-helpers';
import { type ParsedOptionsRecord } from '../../shared-command-utils';
import { writeFileAtomically } from '../../../../core/filesystem';
import { inspectTaskEventFile } from '../../../../gate-runtime/task-events-integrity';
import { buildOperatorNextActionBlock } from '../../../../gates/shared/operator-action-output';
import { readDependencyTimelineEvents } from '../result/review-dependency-timeline';
import { resolveTaskOwnedReviewerScratchArtifactPath } from './review-artifact-path-support';
import {
    getReviewerLaunchLaneReservationPath,
    withReviewerLaunchLaneTransaction
} from './reviewer-launch-lane-transaction';
import {
    findMatchingReviewerDelegationStartedEvent,
    isValidUtcIso8601Timestamp
} from './review-launch-artifact-fields';
import {
    assertArtifactReviewLaneEvidence,
    assertArtifactReviewLaneEvidenceMatchesAuthority,
    assertCanonicalReviewTypeId,
    resolveAuthenticatedReviewLaneContract
} from '../review-lane-contract';

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getEventStringField(
    record: Record<string, unknown> | null,
    snakeCaseKey: string,
    camelCaseKey: string
): string {
    return String(record?.[snakeCaseKey] ?? record?.[camelCaseKey] ?? '').trim();
}

function hasMatchingReviewerLaunchFailedEvent(options: {
    timelineEvents: ReturnType<typeof readDependencyTimelineEvents>;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: string;
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerLaunchAttemptId: string;
    reviewerLaunchArtifactSha256: string;
    invocationId: string;
    delegationStartedAtUtc: string;
    launchFailedAtUtc: string;
    failureReason: string;
}): boolean {
    return options.timelineEvents.some((event) => {
        const details = event.details;
        const eventIdentity = getEventStringField(details, 'reviewer_identity', 'reviewerIdentity')
            || getEventStringField(details, 'reviewer_session_id', 'reviewerSessionId');
        const eventInvocationId = getEventStringField(details, 'provider_invocation_id', 'providerInvocationId')
            || getEventStringField(details, 'controller_invocation_id', 'controllerInvocationId');
        return /^[0-9a-f]{64}$/.test(event.integrity?.event_sha256 || '')
            && event.event_type === 'REVIEWER_LAUNCH_FAILED'
            && getEventStringField(details, 'task_id', 'taskId') === options.taskId
            && getEventStringField(details, 'review_type', 'reviewType').toLowerCase() === options.reviewType
            && getEventStringField(
                details,
                'reviewer_execution_mode',
                'reviewerExecutionMode'
            ) === options.reviewerExecutionMode
            && eventIdentity === options.reviewerIdentity
            && getEventStringField(
                details,
                'review_context_sha256',
                'reviewContextSha256'
            ).toLowerCase() === options.reviewContextSha256
            && getEventStringField(
                details,
                'routing_event_sha256',
                'routingEventSha256'
            ).toLowerCase() === options.routingEventSha256
            && getEventStringField(
                details,
                'reviewer_launch_attempt_id',
                'reviewerLaunchAttemptId'
            ).toLowerCase() === options.reviewerLaunchAttemptId
            && getEventStringField(
                details,
                'reviewer_launch_artifact_sha256',
                'reviewerLaunchArtifactSha256'
            ).toLowerCase() === options.reviewerLaunchArtifactSha256
            && eventInvocationId === options.invocationId
            && getEventStringField(
                details,
                'delegation_started_at_utc',
                'delegationStartedAtUtc'
            ) === options.delegationStartedAtUtc
            && getEventStringField(
                details,
                'launch_failed_at_utc',
                'launchFailedAtUtc'
            ) === options.launchFailedAtUtc
            && getEventStringField(
                details,
                'launch_failure_reason',
                'launchFailureReason'
            ) === options.failureReason;
    });
}

export async function persistReviewerLaunchFailedTransition(options: {
    artifactPath: string;
    originalArtifactText: string;
    failedArtifact: Record<string, unknown>;
    recoveringPersistedFailure: boolean;
    reviewType: string;
    emitFailedEvent: (failedArtifactSha256: string) => Promise<boolean>;
    hasMatchingFailedEvent: (failedArtifactSha256: string) => boolean;
}): Promise<string> {
    if (!options.recoveringPersistedFailure) {
        writeReviewArtifactJson(options.artifactPath, options.failedArtifact);
    }
    const failedArtifactSha256 = fileSha256(options.artifactPath) || '';
    if (!failedArtifactSha256) {
        if (!options.recoveringPersistedFailure) {
            writeFileAtomically(options.artifactPath, options.originalArtifactText, { encoding: 'utf8' });
        }
        throw new Error(
            `Reviewer launch failure requires a hashable failed launch artifact for '${options.reviewType}'.`
        );
    }
    if (options.hasMatchingFailedEvent(failedArtifactSha256)) {
        return failedArtifactSha256;
    }

    let appendFailure: unknown = null;
    let appendCommitted = false;
    try {
        appendCommitted = await options.emitFailedEvent(failedArtifactSha256);
    } catch (error) {
        appendFailure = error;
    }
    if (appendCommitted || options.hasMatchingFailedEvent(failedArtifactSha256)) {
        return failedArtifactSha256;
    }

    const appendFailureSuffix = appendFailure
        ? ` Cause: ${getErrorMessage(appendFailure)}`
        : '';
    if (options.recoveringPersistedFailure) {
        throw new Error(
            `Reviewer launch failure requires REVIEWER_LAUNCH_FAILED telemetry for '${options.reviewType}'. ` +
            'The recoverable failed artifact was retained so the same terminal transition can be retried.' +
            appendFailureSuffix
        );
    }
    try {
        writeFileAtomically(options.artifactPath, options.originalArtifactText, { encoding: 'utf8' });
    } catch (rollbackError) {
        throw new Error(
            `Reviewer launch failure requires REVIEWER_LAUNCH_FAILED telemetry for '${options.reviewType}'. ` +
            `Telemetry persistence failed and the delegation-started artifact rollback also failed: ` +
            `${getErrorMessage(rollbackError)}.` +
            appendFailureSuffix
        );
    }
    throw new Error(
        `Reviewer launch failure requires REVIEWER_LAUNCH_FAILED telemetry for '${options.reviewType}'. ` +
        'The original delegation-started artifact was restored because telemetry could not be persisted.' +
        appendFailureSuffix
    );
}

export interface ReviewerLaunchFailedHandlerDependencies {
    getStringField: typeof import('../index').getStringField;
    parseReviewerIdentity: typeof import('../index').parseReviewerIdentity;
    readJsonFile: typeof import('../index').readJsonFile;
    resolveCanonicalPreflightArtifactPath: typeof import('../index').resolveCanonicalPreflightArtifactPath;
    resolveReviewerLaunchArtifactPathForWrite: typeof import('../index').resolveReviewerLaunchArtifactPathForWrite;
    resolveReviewerLaunchInputArtifactPath: typeof import('../index').resolveReviewerLaunchInputArtifactPath;
}

export function createReviewerLaunchFailedHandler(deps: ReviewerLaunchFailedHandlerDependencies) {
    const {
        getStringField,
        parseReviewerIdentity,
        readJsonFile,
        resolveCanonicalPreflightArtifactPath,
        resolveReviewerLaunchArtifactPathForWrite,
        resolveReviewerLaunchInputArtifactPath
    } = deps;

    return async function handleRecordReviewerLaunchFailed(gateArgv: string[]): Promise<void> {
        const defs = {
            '--task-id': { key: 'taskId', type: 'string' },
            '--review-type': { key: 'reviewType', type: 'string' },
            '--review-context-path': { key: 'reviewContextPath', type: 'string' },
            '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
            '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
            '--reviewer-launch-artifact-path': { key: 'reviewerLaunchArtifactPath', type: 'string' },
            '--provider-invocation-id': { key: 'providerInvocationId', type: 'string' },
            '--controller-invocation-id': { key: 'controllerInvocationId', type: 'string' },
            '--failure-reason': { key: 'failureReason', type: 'string' },
            '--repo-root': { key: 'repoRoot', type: 'string' }
        };
        const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
        const options = rawOptions as ParsedOptionsRecord;
        const taskId = assertValidTaskId(options.taskId);
        const reviewType = assertCanonicalReviewTypeId(options.reviewType);
        const failureReason = String(options.failureReason || '').trim();
        if (failureReason.length < 12) {
            throw new Error('FailureReason must explain the provider/controller launch failure in at least 12 characters.');
        }
        const { reviewerExecutionMode, reviewerIdentity } = parseReviewerIdentity(
            options,
            "ReviewerExecutionMode is required. Expected 'delegated_subagent'.",
            { requireResolvedIdentity: true }
        );
        const providerInvocationId = String(options.providerInvocationId || '').trim();
        const controllerInvocationId = String(options.controllerInvocationId || '').trim();
        if (!providerInvocationId && !controllerInvocationId) {
            throw new Error('ProviderInvocationId or ControllerInvocationId is required for explicit failed-launch recovery.');
        }
        if (providerInvocationId && controllerInvocationId) {
            throw new Error('Provide either --provider-invocation-id or --controller-invocation-id, not both.');
        }

        const repoRoot = normalizePathValue(options.repoRoot || '.');
        assertReviewLifecycleGuard(repoRoot, taskId, 'record-reviewer-launch-failed', 'review_phase');
        const canonicalLaunchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
            repoRoot,
            taskId,
            reviewType,
            artifactPathValue: undefined
        });
        return await withReviewerLaunchLaneTransaction(canonicalLaunchArtifactPath, async () => {
        const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
        const contextPath = resolveCanonicalReviewContextPath({
            reviewsRoot: path.dirname(preflightPath),
            taskId,
            reviewType,
            explicitPath: options.reviewContextPath ? String(options.reviewContextPath) : '',
            repoRoot
        });
        const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
            repoRoot,
            taskId,
            reviewType,
            artifactPathValue: options.reviewerLaunchArtifactPath
        });
        const launchInputArtifactPath = resolveTaskOwnedReviewerScratchArtifactPath({
            repoRoot,
            taskId,
            artifactPath: resolveReviewerLaunchInputArtifactPath(launchArtifactPath),
            label: 'Reviewer launch input artifact'
        });
        if (!fs.existsSync(launchArtifactPath) || !fs.statSync(launchArtifactPath).isFile()) {
            throw new Error(`Reviewer launch artifact not found: ${normalizePath(launchArtifactPath)}.`);
        }
        const originalArtifactText = fs.readFileSync(launchArtifactPath, 'utf8');
        const artifact = readJsonFile(launchArtifactPath, 'Reviewer launch artifact');
        const launchInputArtifact = readJsonFile(
            launchInputArtifactPath,
            'Reviewer launch input artifact'
        );
        const laneReservationPath = resolveTaskOwnedReviewerScratchArtifactPath({
            repoRoot,
            taskId,
            artifactPath: getReviewerLaunchLaneReservationPath(launchArtifactPath),
            label: 'Reviewer launch lane reservation'
        });
        const laneReservation = readJsonFile(
            laneReservationPath,
            'Reviewer launch lane reservation'
        );
        let reviewLaneContract: ReturnType<typeof resolveAuthenticatedReviewLaneContract> | null = null;
        try {
            reviewLaneContract = resolveAuthenticatedReviewLaneContract({
                preflight: readJsonFile(preflightPath, 'Preflight artifact'),
                reviewContext: readJsonFile(contextPath, 'Review context artifact'),
                reviewType
            });
        } catch {
            // A started attempt can outlive the canonical context that prepared it. Its provider-owned
            // start event authenticates the immutable launch artifact before attempt-bound fallback.
        }
        if (reviewLaneContract) {
            assertArtifactReviewLaneEvidence(artifact, reviewLaneContract, 'Reviewer launch artifact');
            assertArtifactReviewLaneEvidence(
                launchInputArtifact,
                reviewLaneContract,
                'Reviewer launch input artifact'
            );
            assertArtifactReviewLaneEvidence(
                laneReservation,
                reviewLaneContract,
                'Reviewer launch lane reservation'
            );
        }
        const attestationState = getStringField(artifact, 'attestation_state', 'attestationState');
        const recoveringPersistedFailure = attestationState === 'launch_failed';
        if (attestationState !== 'delegation_started' && !recoveringPersistedFailure) {
            throw new Error(
                `record-reviewer-launch-failed requires attestation_state 'delegation_started' or a recoverable ` +
                `'launch_failed' artifact, got '${attestationState || 'missing'}'.`
            );
        }
        if (getStringField(artifact, 'task_id', 'taskId') !== taskId) {
            throw new Error('Reviewer launch artifact task_id does not match the requested task.');
        }
        if (getStringField(artifact, 'review_type', 'reviewType').toLowerCase() !== reviewType) {
            throw new Error('Reviewer launch artifact review_type does not match the requested lane.');
        }
        if (getStringField(artifact, 'reviewer_execution_mode', 'reviewerExecutionMode') !== reviewerExecutionMode) {
            throw new Error('Reviewer launch artifact execution mode does not match failed-launch recovery input.');
        }
        if (getStringField(artifact, 'reviewer_identity', 'reviewerIdentity') !== reviewerIdentity) {
            throw new Error('Reviewer launch artifact identity does not match failed-launch recovery input.');
        }
        const artifactContextPath = getStringField(artifact, 'review_context_path', 'reviewContextPath');
        const comparablePath = (value: string): string => {
            const absolutePath = path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
            const normalizedPath = normalizePath(path.resolve(absolutePath));
            return process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
        };
        if (!artifactContextPath || comparablePath(artifactContextPath) !== comparablePath(contextPath)) {
            throw new Error('Reviewer launch artifact review context path does not match the requested canonical context.');
        }
        const launchContextSha256 = getStringField(artifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(launchContextSha256)) {
            throw new Error('Reviewer launch artifact is missing a valid immutable review_context_sha256.');
        }
        const reviewerLaunchAttemptId = getStringField(
            artifact,
            'reviewer_launch_attempt_id',
            'reviewerLaunchAttemptId'
        );
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reviewerLaunchAttemptId)) {
            throw new Error('Reviewer launch artifact is missing a valid immutable reviewer_launch_attempt_id.');
        }
        const artifactProviderInvocationId = getStringField(artifact, 'provider_invocation_id', 'providerInvocationId');
        const artifactControllerInvocationId = getStringField(artifact, 'controller_invocation_id', 'controllerInvocationId');
        if (providerInvocationId !== artifactProviderInvocationId || controllerInvocationId !== artifactControllerInvocationId) {
            throw new Error('Failed-launch invocation identity must exactly match the delegation-started attempt.');
        }

        const persistedFailureReason = getStringField(
            artifact,
            'launch_failure_reason',
            'launchFailureReason'
        );
        if (recoveringPersistedFailure && persistedFailureReason !== failureReason) {
            throw new Error(
                'Failed-launch recovery reason must exactly match the durable failed launch artifact.'
            );
        }
        const persistedLaunchFailedAtUtc = getStringField(
            artifact,
            'launch_failed_at_utc',
            'launchFailedAtUtc'
        );
        if (
            recoveringPersistedFailure
            && !isValidUtcIso8601Timestamp(persistedLaunchFailedAtUtc)
        ) {
            throw new Error(
                'Recoverable failed launch artifact is missing a valid immutable launch_failed_at_utc.'
            );
        }
        const launchFailedAtUtc = recoveringPersistedFailure
            ? persistedLaunchFailedAtUtc
            : new Date().toISOString();
        const failedArtifact: Record<string, unknown> = recoveringPersistedFailure
            ? artifact
            : {
                ...artifact,
                attestation_state: 'launch_failed',
                launch_failure_reason: failureReason,
                launch_failed_at_utc: launchFailedAtUtc,
                launch_failure_recorded_by: 'record-reviewer-launch-failed'
            };
        const routingEventSha256 = getStringField(
            artifact,
            'routing_event_sha256',
            'routingEventSha256'
        ).toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(routingEventSha256)) {
            throw new Error('Reviewer launch artifact is missing a valid immutable routing_event_sha256.');
        }
        const delegationStartedAtUtc = getStringField(
            artifact,
            'delegation_started_at_utc',
            'delegationStartedAtUtc'
        );
        if (!isValidUtcIso8601Timestamp(delegationStartedAtUtc)) {
            throw new Error('Reviewer launch artifact is missing a valid immutable delegation_started_at_utc.');
        }
        const invocationId = providerInvocationId || controllerInvocationId;
        const timelinePath = gateHelpers.joinOrchestratorPath(
            repoRoot,
            path.join('runtime', 'task-events', `${taskId}.jsonl`)
        );
        const timelineIntegrity = inspectTaskEventFile(timelinePath, taskId);
        if (!timelineIntegrity.status.startsWith('PASS')) {
            throw new Error(
                `Reviewer launch failure cannot authenticate task timeline integrity for '${reviewType}': ` +
                `${timelineIntegrity.status}.`
            );
        }
        let timelineEvents = readDependencyTimelineEvents(timelinePath);
        const failedEventMatchesArtifact = (artifactSha256: string): boolean =>
            hasMatchingReviewerLaunchFailedEvent({
                timelineEvents,
                taskId,
                reviewType,
                reviewerExecutionMode,
                reviewerIdentity,
                reviewContextSha256: launchContextSha256,
                routingEventSha256,
                reviewerLaunchAttemptId: reviewerLaunchAttemptId.toLowerCase(),
                reviewerLaunchArtifactSha256: artifactSha256.toLowerCase(),
                invocationId,
                delegationStartedAtUtc,
                launchFailedAtUtc,
                failureReason
            });
        const currentArtifactSha256 = fileSha256(launchArtifactPath) || '';
        if (recoveringPersistedFailure && !failedEventMatchesArtifact(currentArtifactSha256)) {
            throw new Error(
                `Reviewer launch failure cannot authenticate the recoverable failed attempt for '${reviewType}'.`
            );
        }
        const startedEvent = findMatchingReviewerDelegationStartedEvent(
            timelineEvents,
            {
                taskId,
                reviewType,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity,
                reviewContextSha256: launchContextSha256,
                routingEventSha256,
                reviewerLaunchAttemptId,
                launchBindingSha256: getStringField(
                    artifact,
                    'launch_binding_sha256',
                    'launchBindingSha256'
                ),
                preparedLaunchEventSha256: getStringField(
                    artifact,
                    'prepared_launch_event_sha256',
                    'preparedLaunchEventSha256'
                ),
                reviewerLaunchArtifactSha256: recoveringPersistedFailure
                    ? null
                    : currentArtifactSha256,
                providerInvocationId: invocationId,
                delegationStartedAtUtc,
                minSequenceExclusive: 0
            }
        );
        if (!/^[0-9a-f]{64}$/.test(startedEvent?.integrity?.event_sha256 || '')) {
            throw new Error(
                `Reviewer launch failure cannot authenticate integrity-bearing start telemetry for '${reviewType}'.`
            );
        }
        if (!reviewLaneContract) {
            assertArtifactReviewLaneEvidenceMatchesAuthority(
                artifact,
                launchInputArtifact,
                'Reviewer launch input artifact'
            );
            assertArtifactReviewLaneEvidenceMatchesAuthority(
                artifact,
                laneReservation,
                'Reviewer launch lane reservation'
            );
        }
        const existingFailedEventForAttempt = timelineEvents.find((event) => (
            event.event_type === 'REVIEWER_LAUNCH_FAILED'
            && getEventStringField(
                event.details,
                'reviewer_launch_attempt_id',
                'reviewerLaunchAttemptId'
            ).toLowerCase() === reviewerLaunchAttemptId.toLowerCase()
        ));
        if (existingFailedEventForAttempt) {
            const existingArtifactSha256 = fileSha256(launchArtifactPath) || '';
            if (!recoveringPersistedFailure || !failedEventMatchesArtifact(existingArtifactSha256)) {
                throw new Error(
                    'Failed-launch recovery found conflicting REVIEWER_LAUNCH_FAILED telemetry for the same immutable launch attempt.'
                );
            }
        }
        const failedArtifactSha256 = await persistReviewerLaunchFailedTransition({
            artifactPath: launchArtifactPath,
            originalArtifactText,
            failedArtifact,
            recoveringPersistedFailure,
            reviewType,
            hasMatchingFailedEvent: failedEventMatchesArtifact,
            emitFailedEvent: async (artifactSha256) => {
                try {
                    const failedEvent = await emitReviewerLaunchFailedEventAsync(
                        gateHelpers.joinOrchestratorPath(repoRoot, ''),
                        taskId,
                        reviewType,
                        reviewerExecutionMode,
                        reviewerIdentity,
                        launchContextSha256,
                        getStringField(artifact, 'routing_event_sha256', 'routingEventSha256'),
                        {
                            launchDetails: {
                                reviewer_launch_attempt_id: reviewerLaunchAttemptId,
                                reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
                                reviewer_launch_artifact_sha256: artifactSha256,
                                provider_invocation_id: providerInvocationId || null,
                                controller_invocation_id: controllerInvocationId || null,
                                delegation_started_at_utc: delegationStartedAtUtc,
                                launch_failed_at_utc: launchFailedAtUtc,
                                launch_failure_reason: failureReason,
                                failure_reason: failureReason
                            }
                        }
                    );
                    return Boolean(
                        failedEvent
                        && !taskEventAppendHasBlockingFailure(failedEvent, false)
                    );
                } finally {
                    timelineEvents = readDependencyTimelineEvents(timelinePath);
                }
            }
        });

        const navigatorCommand = `${gateHelpers.isOrchestratorSourceCheckout(repoRoot)
            ? 'node bin/garda.js'
            : 'node garda-agent-orchestrator/bin/garda.js'} next-step "${taskId}" --repo-root "."`;
        console.log(buildOperatorNextActionBlock({
            status: 'PASSED',
            gate: 'record-reviewer-launch-failed',
            action: 'Restart the failed reviewer launch cycle',
            reason: `Immutable reviewer launch attempt '${reviewerLaunchAttemptId}' was terminally marked failed.`,
            command: navigatorCommand,
            detailsPath: launchArtifactPath,
            detailsHint: 'The failed attempt remains preserved and cannot be completed or reused.'
        }).join('\n'));
        console.log('');
        console.log(`REVIEWER_LAUNCH_FAILED: ${reviewType}`);
        console.log(`ReviewerIdentity: ${reviewerIdentity}`);
        console.log(`ReviewerLaunchAttemptId: ${reviewerLaunchAttemptId}`);
        console.log(`LaunchArtifactPath: ${normalizePath(launchArtifactPath)}`);
        console.log(`LaunchArtifactSha256: ${failedArtifactSha256}`);
        console.log(`LaunchFailedAtUtc: ${launchFailedAtUtc}`);
        console.log(`NextStep: ${navigatorCommand}`);
        });
    };
}
