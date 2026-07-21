import * as path from 'node:path';

import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleNameForTarget
} from '../../../../core/constants';
import {
    REVIEWER_ONE_SHOT_LAUNCH_DEFAULT_INSTRUCTION,
    REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION
} from '../../../../gate-runtime/reviewer-session-contract';
import { isOrchestratorSourceCheckout, normalizePath } from '../../../../gates/shared/helpers';

export interface ReviewerLaunchCommandTemplateOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewContextPath: string;
    launchArtifactPath: string;
    launchInputArtifactPath: string;
    launchInputArtifactSha256: string;
}

const RESOLVED_REVIEWER_IDENTITY_PLACEHOLDER = '<agent:resolved-provider-reviewer-id-from-delegated-agent>';
const PROVIDER_INVOCATION_ID_PLACEHOLDER = '<provider-owned invocation id from delegated reviewer launch result>';
const PROVIDER_ATTESTATION_SOURCE_PLACEHOLDER = '<provider-owned attestation source from delegated reviewer launch result>';
const PROVIDER_FAILURE_REASON_PLACEHOLDER = '<replace with provider/controller failure reason>';

function quoteLaunchCommandValue(value: string): string {
    const normalizedValue = value.replace(/\\/g, '/');
    if (normalizedValue.includes("'")) {
        throw new Error(`Cannot emit a shell-agnostic copy-paste reviewer launch command for values containing apostrophes: ${normalizedValue}`);
    }
    return `'${normalizedValue}'`;
}

function toRepoRelativeLaunchCommandPath(repoRoot: string, artifactPath: string): string {
    if (/^<[^>]+>$/.test(String(artifactPath || '').trim())) {
        return artifactPath;
    }
    const relativePath = path.relative(repoRoot, artifactPath);
    if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return normalizePath(artifactPath);
    }
    return normalizePath(relativePath);
}

function buildLaunchCommandCliPrefix(repoRoot: string): string {
    return isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
}

export function printReviewerLaunchHandoffLines(): void {
    console.log('OneShotLaunchState: default_handoff_ready_not_review_evidence');
    console.log('ReviewerLaunchInputArtifactRole: reviewer_facing_handoff_not_launcher_control_metadata');
    console.log(`OneShotLaunchInstruction: ${REVIEWER_ONE_SHOT_LAUNCH_DEFAULT_INSTRUCTION}`);
}

export function buildReviewerLaunchNextAction(): string {
    return (
        `${REVIEWER_ONE_SHOT_LAUNCH_DEFAULT_INSTRUCTION} ` +
        'ReviewerLaunchArtifactPath is main-agent control metadata; ReviewerLaunchInputArtifactPath is the reviewer-facing handoff. ' +
        'Do not reconstruct reviewer prompts from memory. ' +
        `${REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION} ` +
        'Immediately run record-reviewer-delegation-started with the resolved provider reviewer identity and launch_input evidence. ' +
        'If the reviewer returns a transport or runtime error without valid review output, run record-reviewer-launch-failed and do not run complete-reviewer-launch. ' +
        'Run complete-reviewer-launch only after successful reviewer completion and after the returned review output is available at ReviewOutputPath.'
    );
}

export function buildPreparedReviewerLaunchNextAction(handoffArtifactNames: string): string {
    return (
        `Launch a fresh delegated reviewer once with ${handoffArtifactNames} as opaque handoff artifacts using the exact CopyPasteReviewerLaunchPrompt or reviewer-facing ReviewerLaunchInputArtifactPath. ` +
        'Use ReviewerLaunchArtifactPath only as main-agent control metadata, not as the clean-context reviewer prompt. ' +
        `${REVIEWER_ONE_SHOT_LAUNCH_DEFAULT_INSTRUCTION} ` +
        `${REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION} ` +
        'Do not open or summarize the generated review context in the main agent. Then update only the ' +
        'after_launch_required_updates fields while preserving the prepared hashes. ' +
        'Run record-reviewer-delegation-started immediately after provider launch. ' +
        'If the reviewer returns a transport or runtime error without valid review output, run record-reviewer-launch-failed and do not run complete-reviewer-launch. ' +
        'Run complete-reviewer-launch only after successful reviewer completion and after the returned review output is available at ReviewOutputPath.'
    );
}

export function buildRecordReviewerDelegationStartedCommandTemplate(options: ReviewerLaunchCommandTemplateOptions): string {
    const cliPrefix = buildLaunchCommandCliPrefix(options.repoRoot);
    return [
        `${cliPrefix} gate record-reviewer-delegation-started`,
        '--task-id', quoteLaunchCommandValue(options.taskId),
        '--review-type', quoteLaunchCommandValue(options.reviewType),
        '--review-context-path', quoteLaunchCommandValue(toRepoRelativeLaunchCommandPath(options.repoRoot, options.reviewContextPath)),
        '--reviewer-execution-mode', quoteLaunchCommandValue('delegated_subagent'),
        '--reviewer-identity', quoteLaunchCommandValue(RESOLVED_REVIEWER_IDENTITY_PLACEHOLDER),
        '--reviewer-launch-artifact-path', quoteLaunchCommandValue(toRepoRelativeLaunchCommandPath(options.repoRoot, options.launchArtifactPath)),
        '--provider-invocation-id', quoteLaunchCommandValue(PROVIDER_INVOCATION_ID_PLACEHOLDER),
        '--attestation-source', quoteLaunchCommandValue(PROVIDER_ATTESTATION_SOURCE_PLACEHOLDER),
        '--launch-input-mode', quoteLaunchCommandValue('launch_artifact_path'),
        '--launch-input-artifact-path', quoteLaunchCommandValue(toRepoRelativeLaunchCommandPath(options.repoRoot, options.launchInputArtifactPath)),
        '--launch-input-sha256', quoteLaunchCommandValue(options.launchInputArtifactSha256),
        '--fork-context', 'false',
        '--repo-root', quoteLaunchCommandValue('.')
    ].join(' ');
}

export function buildCompleteReviewerLaunchCommandTemplate(options: ReviewerLaunchCommandTemplateOptions): string {
    const cliPrefix = buildLaunchCommandCliPrefix(options.repoRoot);
    return [
        `${cliPrefix} gate complete-reviewer-launch`,
        '--task-id', quoteLaunchCommandValue(options.taskId),
        '--review-type', quoteLaunchCommandValue(options.reviewType),
        '--review-context-path', quoteLaunchCommandValue(toRepoRelativeLaunchCommandPath(options.repoRoot, options.reviewContextPath)),
        '--reviewer-execution-mode', quoteLaunchCommandValue('delegated_subagent'),
        '--reviewer-identity', quoteLaunchCommandValue(RESOLVED_REVIEWER_IDENTITY_PLACEHOLDER),
        '--reviewer-launch-artifact-path', quoteLaunchCommandValue(toRepoRelativeLaunchCommandPath(options.repoRoot, options.launchArtifactPath)),
        '--provider-invocation-id', quoteLaunchCommandValue(PROVIDER_INVOCATION_ID_PLACEHOLDER),
        '--attestation-source', quoteLaunchCommandValue(PROVIDER_ATTESTATION_SOURCE_PLACEHOLDER),
        '--launch-input-mode', quoteLaunchCommandValue('launch_artifact_path'),
        '--launch-input-artifact-path', quoteLaunchCommandValue(toRepoRelativeLaunchCommandPath(options.repoRoot, options.launchInputArtifactPath)),
        '--launch-input-sha256', quoteLaunchCommandValue(options.launchInputArtifactSha256),
        '--fork-context', 'false',
        '--record-invocation',
        '--repo-root', quoteLaunchCommandValue('.')
    ].join(' ');
}

export function buildRecordReviewerLaunchFailedCommandTemplate(options: ReviewerLaunchCommandTemplateOptions): string {
    const cliPrefix = buildLaunchCommandCliPrefix(options.repoRoot);
    return [
        `${cliPrefix} gate record-reviewer-launch-failed`,
        '--task-id', quoteLaunchCommandValue(options.taskId),
        '--review-type', quoteLaunchCommandValue(options.reviewType),
        '--review-context-path', quoteLaunchCommandValue(toRepoRelativeLaunchCommandPath(options.repoRoot, options.reviewContextPath)),
        '--reviewer-execution-mode', quoteLaunchCommandValue('delegated_subagent'),
        '--reviewer-identity', quoteLaunchCommandValue(RESOLVED_REVIEWER_IDENTITY_PLACEHOLDER),
        '--reviewer-launch-artifact-path', quoteLaunchCommandValue(toRepoRelativeLaunchCommandPath(options.repoRoot, options.launchArtifactPath)),
        '--provider-invocation-id', quoteLaunchCommandValue(PROVIDER_INVOCATION_ID_PLACEHOLDER),
        '--failure-reason', quoteLaunchCommandValue(PROVIDER_FAILURE_REASON_PLACEHOLDER),
        '--repo-root', quoteLaunchCommandValue('.')
    ].join(' ');
}
