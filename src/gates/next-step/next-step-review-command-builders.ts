import {
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    buildBundleRelativePath,
    quoteCommandValue,
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    isRestartWorkflowConfigScopeAuthorized,
    omitWorkflowConfigChangedFiles,
    resolveRestartCommandChangedFiles
} from '../recovery/restart-command-scope';
import {
    isSourceCheckoutGeneratedRuntimeArtifactPath
} from '../shared/generated-runtime-artifacts';
import {
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';

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
    launchInputMode: 'copy_paste_prompt' | 'launch_artifact_path';
    launchInputArtifactPath?: string | null;
    launchInputSha256?: string | null;
    providerInvocationId?: string | null;
    controllerInvocationId?: string | null;
    attestationSource?: string | null;
}): string {
    const launchInputSha256 = String(params.launchInputSha256 || '').trim()
        || (
            params.launchInputMode === 'launch_artifact_path'
                ? '<ReviewerLaunchInputArtifactSha256>'
                : '<CopyPasteReviewerLaunchPromptSha256>'
        );
    const providerInvocationId = String(params.providerInvocationId || '').trim();
    const controllerInvocationId = String(params.controllerInvocationId || '').trim();
    const invocationArgument = controllerInvocationId
        ? `--controller-invocation-id ${quoteCommandValue(controllerInvocationId)}`
        : `--provider-invocation-id ${quoteCommandValue(
            providerInvocationId || PROVIDER_INVOCATION_ID_PLACEHOLDER
        )}`;
    const attestationSource = String(params.attestationSource || '').trim()
        || PROVIDER_ATTESTATION_SOURCE_PLACEHOLDER;
    const commandParts = [
        `${params.cliPrefix} gate record-reviewer-delegation-started`,
        `--task-id ${quoteCommandValue(params.taskId)}`,
        `--review-type ${quoteCommandValue(params.reviewType)}`,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity ${quoteCommandValue(params.reviewerIdentity)}`,
        `--reviewer-launch-artifact-path ${quoteCommandValue(normalizePath(params.launchArtifactPath))}`,
        invocationArgument,
        `--attestation-source ${quoteCommandValue(attestationSource)}`,
        `--launch-input-mode ${quoteCommandValue(params.launchInputMode)}`
    ];
    if (params.launchInputMode === 'launch_artifact_path') {
        const launchInputArtifactPath = String(params.launchInputArtifactPath || '').trim()
            || '<ReviewerLaunchInputArtifactPath>';
        commandParts.push(
            `--launch-input-artifact-path ${quoteCommandValue(normalizePath(launchInputArtifactPath))}`
        );
    }
    commandParts.push(
        `--launch-input-sha256 ${quoteCommandValue(launchInputSha256)}`,
        '--fork-context false',
        '--repo-root "."'
    );
    return commandParts.join(' ');
}

export function buildCompleteReviewerLaunchCommand(params: {
    cliPrefix: string;
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    launchArtifactPath: string;
    launchInputMode: 'copy_paste_prompt' | 'launch_artifact_path';
    launchInputArtifactPath?: string | null;
    launchInputSha256?: string | null;
    providerInvocationId?: string | null;
    controllerInvocationId?: string | null;
    attestationSource?: string | null;
    recordInvocation?: boolean;
}): string {
    const launchInputSha256 = String(params.launchInputSha256 || '').trim()
        || (
            params.launchInputMode === 'launch_artifact_path'
                ? '<ReviewerLaunchInputArtifactSha256>'
                : '<CopyPasteReviewerLaunchPromptSha256>'
        );
    const providerInvocationId = String(params.providerInvocationId || '').trim();
    const controllerInvocationId = String(params.controllerInvocationId || '').trim();
    const invocationArguments = controllerInvocationId
        ? [`--controller-invocation-id ${quoteCommandValue(controllerInvocationId)}`]
        : providerInvocationId
            ? [`--provider-invocation-id ${quoteCommandValue(providerInvocationId)}`]
            : [];
    const attestationSource = String(params.attestationSource || '').trim()
        || PROVIDER_ATTESTATION_SOURCE_PLACEHOLDER;
    const commandParts = [
        `${params.cliPrefix} gate complete-reviewer-launch`,
        `--task-id ${quoteCommandValue(params.taskId)}`,
        `--review-type ${quoteCommandValue(params.reviewType)}`,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity ${quoteCommandValue(params.reviewerIdentity)}`,
        `--reviewer-launch-artifact-path ${quoteCommandValue(normalizePath(params.launchArtifactPath))}`,
        ...invocationArguments,
        `--attestation-source ${quoteCommandValue(attestationSource)}`,
        `--launch-input-mode ${quoteCommandValue(params.launchInputMode)}`
    ];
    if (params.launchInputMode === 'launch_artifact_path') {
        const launchInputArtifactPath = String(params.launchInputArtifactPath || '').trim()
            || '<ReviewerLaunchInputArtifactPath>';
        commandParts.push(
            `--launch-input-artifact-path ${quoteCommandValue(normalizePath(launchInputArtifactPath))}`
        );
    }
    commandParts.push(
        `--launch-input-sha256 ${quoteCommandValue(launchInputSha256)}`,
        '--fork-context false',
        ...(params.recordInvocation ? ['--record-invocation'] : []),
        '--repo-root "."'
    );
    return commandParts.join(' ');
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
        `--review-type ${quoteCommandValue(reviewType)}`,
        '--reviewer-execution-mode "delegated_subagent"',
        `--reviewer-identity ${quoteCommandValue(reviewerIdentity)}`,
        `--reviewer-launch-artifact-path ${quoteCommandValue(normalizePath(launchArtifactPath))}`
    ], taskModePath);
}

export function buildRecordReviewResultCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string | null | undefined,
    preflightCommandPath: string,
    taskModePath: string | null,
    reviewOutputPath?: string | null
): string {
    const hasReviewOutputPath = Boolean(String(reviewOutputPath || '').trim());
    const reviewOutputSourcePart = hasReviewOutputPath
        ? `--review-output-path "${toRepoDisplayPath(repoRoot, String(reviewOutputPath))}"`
        : '--review-output-stdin';
    const reviewerIdentityValue = String(reviewerIdentity || '').trim();
    const command = buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'record-review-result', [
        `--review-type "${reviewType}"`,
        `--preflight-path "${preflightCommandPath}"`,
        reviewOutputSourcePart,
        '--reviewer-execution-mode "delegated_subagent"',
        ...(reviewerIdentityValue ? [`--reviewer-identity ${quoteCommandValue(reviewerIdentityValue)}`] : [])
    ], taskModePath);
    return hasReviewOutputPath
        ? command
        : `'<paste exact delegated reviewer output here>' | ${command}`;
}

export function buildRecordReviewOutputCorrectionInvocationCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    correctionArtifactPath: string,
    launchInputSha256: string,
    taskModePath: string | null,
    persistedLaunch?: {
        producerIdentity?: string | null;
        providerInvocationId?: string | null;
        attestationSource?: string | null;
    }
): string {
    const producerIdentity = String(persistedLaunch?.producerIdentity || '').trim()
        || '<agent:resolved-provider-correction-reviewer-id>';
    const providerInvocationId = String(persistedLaunch?.providerInvocationId || '').trim()
        || '<provider-owned correction invocation id>';
    const attestationSource = String(persistedLaunch?.attestationSource || '').trim()
        || '<provider-owned correction attestation source>';
    return buildReviewPhaseCommand(
        repoRoot,
        cliPrefix,
        taskId,
        'record-review-output-correction-invocation',
        [
            `--review-type ${quoteCommandValue(reviewType)}`,
            `--correction-artifact-path ${quoteCommandValue(
                toRepoDisplayPath(repoRoot, correctionArtifactPath)
            )}`,
            `--correction-producer-identity ${quoteCommandValue(
                producerIdentity
            )}`,
            `--provider-invocation-id ${quoteCommandValue(providerInvocationId)}`,
            `--attestation-source ${quoteCommandValue(attestationSource)}`,
            `--launch-input-sha256 ${quoteCommandValue(launchInputSha256)}`,
            '--fork-context false'
        ],
        taskModePath
    );
}

export function buildRestartReviewCycleCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskIntent: string,
    preflightCommandPath: string,
    taskModePath: string | null,
    additionalChangedFiles: readonly string[] = [],
    options: {
        includeChangedFileScope?: boolean;
        reviewType?: string;
        reviewEvidenceOnly?: boolean;
    } = {}
): string {
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    const includeWorkflowConfigFiles = isRestartWorkflowConfigScopeAuthorized(repoRoot, taskId, taskModePath);
    const includeChangedFileScope = options.includeChangedFileScope !== false;
    const changedFiles = includeChangedFileScope
        ? [...new Set([
            ...resolveRestartCommandChangedFiles(repoRoot, preflightCommandPath, { includeWorkflowConfigFiles }),
            ...additionalChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean)
        ])]
            .filter((entry) => includeWorkflowConfigFiles || omitWorkflowConfigChangedFiles([entry]).length > 0)
            .filter((entry) => !isSourceCheckoutGeneratedRuntimeArtifactPath(entry, isSourceCheckout))
            .sort()
        : [];
    return [
        `${cliPrefix} gate restart-review-cycle`,
        `--task-id "${taskId}"`,
        `--task-intent ${quoteCommandValue(taskIntent)}`,
        `--preflight-path ${quoteCommandValue(preflightCommandPath)}`,
        `--impact-analysis ${quoteCommandValue('<replace with main-agent remediation impact analysis>')}`,
        ...(options.reviewType ? [`--review-type ${quoteCommandValue(options.reviewType)}`] : []),
        ...(options.reviewEvidenceOnly ? ['--review-evidence-only'] : []),
        ...changedFiles.map((changedFile) => `--changed-file ${quoteCommandValue(changedFile)}`),
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}
