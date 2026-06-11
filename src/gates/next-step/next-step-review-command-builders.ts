import {
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    buildBundleRelativePath,
    quoteCommandValue,
    toRepoDisplayPath
} from './next-step-command-formatters';

const PROVIDER_INVOCATION_ID_PLACEHOLDER = '<provider-owned invocation id from delegated reviewer launch result>';
const PROVIDER_ATTESTATION_SOURCE_PLACEHOLDER = '<provider-owned attestation source from delegated reviewer launch result>';

export function buildTaskModePathCommandParts(
    repoRoot: string,
    taskId: string,
    taskModePath: string | null
): string[] {
    const trimmedTaskModePath = String(taskModePath || '').trim();
    if (!trimmedTaskModePath) {
        return [];
    }
    const resolvedTaskModePath = resolvePathInsideRepo(trimmedTaskModePath, repoRoot, { allowMissing: true });
    if (!resolvedTaskModePath) {
        return [];
    }
    const defaultTaskModePath = resolvePathInsideRepo(
        buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-task-mode.json`),
        repoRoot,
        { allowMissing: true }
    );
    if (
        defaultTaskModePath
        && normalizePath(resolvedTaskModePath).toLowerCase() === normalizePath(defaultTaskModePath).toLowerCase()
    ) {
        return [];
    }
    return [`--task-mode-path "${toRepoDisplayPath(repoRoot, resolvedTaskModePath)}"`];
}

export function buildReviewPhaseCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    gateName: string,
    parts: string[],
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate ${gateName}`,
        `--task-id "${taskId}"`,
        ...parts,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

export function buildScopedDiffCommand(params: {
    cliPrefix: string;
    reviewType: string;
    preflightCommandPath: string;
    outputPath: string;
    metadataPath: string;
}): string {
    return [
        `${params.cliPrefix} gate build-scoped-diff`,
        `--review-type "${params.reviewType}"`,
        `--preflight-path "${params.preflightCommandPath}"`,
        `--output-path "${params.outputPath}"`,
        `--metadata-path "${params.metadataPath}"`,
        '--repo-root "."'
    ].join(' ');
}

export function buildReviewRoutingCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string | null | undefined,
    taskModePath: string | null
): string {
    const parts = [
        `--review-type "${reviewType}"`,
        '--reviewer-execution-mode "delegated_subagent"'
    ];
    if (String(reviewerIdentity || '').trim()) {
        parts.push(`--reviewer-identity "${String(reviewerIdentity).trim()}"`);
    }
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'record-review-routing', parts, taskModePath);
}

export function buildPrepareReviewerLaunchCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string | null | undefined,
    launchArtifactPath: string,
    taskModePath: string | null
): string {
    const parts = [
        `--review-type "${reviewType}"`,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-launch-artifact-path "${launchArtifactPath}"`
    ];
    if (String(reviewerIdentity || '').trim()) {
        parts.push(`--reviewer-identity "${String(reviewerIdentity).trim()}"`);
    }
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'prepare-reviewer-launch', parts, taskModePath);
}

export function buildRecordReviewerDelegationStartedCommand(params: {
    cliPrefix: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    launchArtifactPath: string;
    launchInputArtifactPath?: string | null;
    launchInputArtifactSha256?: string | null;
}): string {
    const launchInputArtifactSha256 = String(params.launchInputArtifactSha256 || '').trim()
        || '<ReviewerLaunchInputArtifactSha256>';
    const launchInputArtifactPath = String(params.launchInputArtifactPath || '').trim()
        || params.launchArtifactPath;
    return [
        `${params.cliPrefix} gate record-reviewer-delegation-started`,
        `--task-id "${params.taskId}"`,
        `--review-type "${params.reviewType}"`,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity "${params.reviewerIdentity}"`,
        `--reviewer-launch-artifact-path "${params.launchArtifactPath}"`,
        `--provider-invocation-id "${PROVIDER_INVOCATION_ID_PLACEHOLDER}"`,
        `--attestation-source "${PROVIDER_ATTESTATION_SOURCE_PLACEHOLDER}"`,
        '--launch-input-mode "launch_artifact_path"',
        `--launch-input-artifact-path "${launchInputArtifactPath}"`,
        `--launch-input-sha256 "${launchInputArtifactSha256}"`,
        '--fork-context false',
        '--repo-root "."'
    ].join(' ');
}

export function buildCompleteReviewerLaunchCommand(params: {
    cliPrefix: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    launchArtifactPath: string;
    launchInputArtifactPath?: string | null;
    launchInputArtifactSha256?: string | null;
    recordInvocation?: boolean;
}): string {
    const launchInputArtifactSha256 = String(params.launchInputArtifactSha256 || '').trim()
        || '<ReviewerLaunchInputArtifactSha256>';
    const launchInputArtifactPath = String(params.launchInputArtifactPath || '').trim()
        || params.launchArtifactPath;
    return [
        `${params.cliPrefix} gate complete-reviewer-launch`,
        `--task-id "${params.taskId}"`,
        `--review-type "${params.reviewType}"`,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity "${params.reviewerIdentity}"`,
        `--reviewer-launch-artifact-path "${params.launchArtifactPath}"`,
        `--attestation-source "${PROVIDER_ATTESTATION_SOURCE_PLACEHOLDER}"`,
        '--launch-input-mode "launch_artifact_path"',
        `--launch-input-artifact-path "${launchInputArtifactPath}"`,
        `--launch-input-sha256 "${launchInputArtifactSha256}"`,
        '--fork-context false',
        ...(params.recordInvocation ? ['--record-invocation'] : []),
        '--repo-root "."'
    ].join(' ');
}

export function buildRecordReviewerInvocationCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string,
    launchArtifactPath: string,
    taskModePath: string | null
): string {
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'record-review-invocation', [
        `--review-type "${reviewType}"`,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity "${reviewerIdentity}"`,
        `--reviewer-launch-artifact-path "${launchArtifactPath}"`
    ], taskModePath);
}

export function buildRecordReviewResultCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    reviewOutputPath?: string | null
): string {
    const hasReviewOutputPath = Boolean(String(reviewOutputPath || '').trim());
    const reviewOutputSourcePart = hasReviewOutputPath
        ? `--review-output-path "${toRepoDisplayPath(repoRoot, String(reviewOutputPath))}"`
        : '--review-output-stdin';
    const command = buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'record-review-result', [
        `--review-type "${reviewType}"`,
        `--preflight-path "${preflightCommandPath}"`,
        reviewOutputSourcePart,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity "${reviewerIdentity}"`
    ], taskModePath);
    return hasReviewOutputPath
        ? command
        : `'<paste exact delegated reviewer output here>' | ${command}`;
}

export function buildRestartReviewCycleCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskIntent: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate restart-review-cycle`,
        `--task-id "${taskId}"`,
        `--task-intent ${quoteCommandValue(taskIntent)}`,
        `--impact-analysis ${quoteCommandValue('<replace with main-agent remediation impact analysis>')}`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}
