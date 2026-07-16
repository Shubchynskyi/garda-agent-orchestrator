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
import { buildOperatorNextActionBlock } from '../../../../gates/shared/operator-action-output';

export interface ReviewerLaunchFailedHandlerDependencies {
    getStringField: typeof import('../index').getStringField;
    parseReviewerIdentity: typeof import('../index').parseReviewerIdentity;
    readJsonFile: typeof import('../index').readJsonFile;
    resolveCanonicalPreflightArtifactPath: typeof import('../index').resolveCanonicalPreflightArtifactPath;
    resolveReviewerLaunchArtifactPathForWrite: typeof import('../index').resolveReviewerLaunchArtifactPathForWrite;
}

export function createReviewerLaunchFailedHandler(deps: ReviewerLaunchFailedHandlerDependencies) {
    const {
        getStringField,
        parseReviewerIdentity,
        readJsonFile,
        resolveCanonicalPreflightArtifactPath,
        resolveReviewerLaunchArtifactPathForWrite
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
        const reviewType = String(options.reviewType || '').trim().toLowerCase();
        if (!reviewType) throw new Error('ReviewType is required.');
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
        const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
        const contextPath = resolveCanonicalReviewContextPath({
            reviewsRoot: path.dirname(preflightPath),
            taskId,
            reviewType,
            explicitPath: options.reviewContextPath ? String(options.reviewContextPath) : '',
            repoRoot
        });
        const contextSha256 = fileSha256(contextPath);
        if (!contextSha256) {
            throw new Error(`Reviewer launch failure requires a hashable review-context artifact: ${normalizePath(contextPath)}.`);
        }
        const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
            repoRoot,
            taskId,
            reviewType,
            artifactPathValue: options.reviewerLaunchArtifactPath
        });
        if (!fs.existsSync(launchArtifactPath) || !fs.statSync(launchArtifactPath).isFile()) {
            throw new Error(`Reviewer launch artifact not found: ${normalizePath(launchArtifactPath)}.`);
        }
        const originalArtifactText = fs.readFileSync(launchArtifactPath, 'utf8');
        const artifact = readJsonFile(launchArtifactPath, 'Reviewer launch artifact');
        const attestationState = getStringField(artifact, 'attestation_state', 'attestationState');
        if (attestationState !== 'delegation_started') {
            throw new Error(
                `record-reviewer-launch-failed requires attestation_state 'delegation_started', got '${attestationState || 'missing'}'.`
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
        if (getStringField(artifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase() !== contextSha256) {
            throw new Error('Reviewer launch artifact review context does not match the current context.');
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

        const launchFailedAtUtc = new Date().toISOString();
        const failedArtifact = {
            ...artifact,
            attestation_state: 'launch_failed',
            launch_failure_reason: failureReason,
            launch_failed_at_utc: launchFailedAtUtc,
            launch_failure_recorded_by: 'record-reviewer-launch-failed'
        };
        writeReviewArtifactJson(launchArtifactPath, failedArtifact);
        const failedArtifactSha256 = fileSha256(launchArtifactPath) || '';
        const failedEvent = await emitReviewerLaunchFailedEventAsync(
            gateHelpers.joinOrchestratorPath(repoRoot, ''),
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            contextSha256,
            getStringField(artifact, 'routing_event_sha256', 'routingEventSha256'),
            {
                launchDetails: {
                    reviewer_launch_attempt_id: reviewerLaunchAttemptId,
                    reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
                    reviewer_launch_artifact_sha256: failedArtifactSha256,
                    provider_invocation_id: providerInvocationId || null,
                    controller_invocation_id: controllerInvocationId || null,
                    delegation_started_at_utc: getStringField(artifact, 'delegation_started_at_utc', 'delegationStartedAtUtc'),
                    launch_failed_at_utc: launchFailedAtUtc,
                    launch_failure_reason: failureReason,
                    failure_reason: failureReason
                }
            }
        );
        if (!failedEvent || taskEventAppendHasBlockingFailure(failedEvent, false)) {
            fs.writeFileSync(launchArtifactPath, originalArtifactText, 'utf8');
            throw new Error(
                `Reviewer launch failure requires REVIEWER_LAUNCH_FAILED telemetry for '${reviewType}'. ` +
                'The immutable launch artifact was restored because telemetry could not be persisted.'
            );
        }

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
    };
}
