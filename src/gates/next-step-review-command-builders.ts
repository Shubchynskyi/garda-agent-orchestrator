import {
    normalizePath,
    resolvePathInsideRepo
} from './helpers';
import {
    buildBundleRelativePath,
    quoteCommandValue,
    toRepoDisplayPath
} from './next-step-command-formatters';

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
    reviewerIdentity: string,
    taskModePath: string | null
): string {
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'record-review-routing', [
        `--review-type "${reviewType}"`,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity "${reviewerIdentity}"`
    ], taskModePath);
}

export function buildPrepareReviewerLaunchCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string,
    launchArtifactPath: string,
    taskModePath: string | null
): string {
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'prepare-reviewer-launch', [
        `--review-type "${reviewType}"`,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity "${reviewerIdentity}"`,
        `--reviewer-launch-artifact-path "${launchArtifactPath}"`
    ], taskModePath);
}

export function buildCompleteReviewerLaunchCommand(params: {
    cliPrefix: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    launchArtifactPath: string;
    launchInputArtifactSha256?: string | null;
    recordInvocation?: boolean;
}): string {
    const launchInputArtifactSha256 = String(params.launchInputArtifactSha256 || '').trim()
        || '<prepared-launch-artifact-sha256>';
    return [
        `${params.cliPrefix} gate complete-reviewer-launch`,
        `--task-id "${params.taskId}"`,
        `--review-type "${params.reviewType}"`,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity "${params.reviewerIdentity}"`,
        `--reviewer-launch-artifact-path "${params.launchArtifactPath}"`,
        '--provider-invocation-id "<actual-invocation-id>"',
        '--attestation-source "<provider-source>"',
        '--launch-input-mode "launch_artifact_path"',
        `--launch-input-artifact-path "${params.launchArtifactPath}"`,
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
    taskModePath: string | null
): string {
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'record-review-result', [
        `--review-type "${reviewType}"`,
        `--preflight-path "${preflightCommandPath}"`,
        '--review-output-stdin',
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity "${reviewerIdentity}"`
    ], taskModePath);
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
