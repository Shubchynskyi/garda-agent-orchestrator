import {
    getArtifactStringField,
    stringSha256
} from './next-step-reviewer-launch-evidence-shared';

export function hasReviewerLaunchInputEvidence(launchArtifact: Record<string, unknown>): boolean {
    const copyPastePrompt = getArtifactStringField(
        launchArtifact,
        'copy_paste_reviewer_launch_prompt',
        'copyPasteReviewerLaunchPrompt'
    );
    const copyPastePromptSha256 = getArtifactStringField(
        launchArtifact,
        'copy_paste_reviewer_launch_prompt_sha256',
        'copyPasteReviewerLaunchPromptSha256'
    ).toLowerCase();
    const launchInputMode = getArtifactStringField(launchArtifact, 'launch_input_mode', 'launchInputMode').toLowerCase();
    const launchInputSha256 = getArtifactStringField(launchArtifact, 'launch_input_sha256', 'launchInputSha256').toLowerCase();
    const launchInputArtifactPath = getArtifactStringField(launchArtifact, 'launch_input_artifact_path', 'launchInputArtifactPath');
    const launchInputArtifactSha256 = getArtifactStringField(
        launchArtifact,
        'launch_input_artifact_sha256',
        'launchInputArtifactSha256'
    ).toLowerCase();
    const preparedLaunchArtifactSha256 = getArtifactStringField(
        launchArtifact,
        'prepared_reviewer_launch_artifact_sha256',
        'preparedReviewerLaunchArtifactSha256'
    ).toLowerCase();
    if (
        !copyPastePrompt
        || !/^[0-9a-f]{64}$/.test(copyPastePromptSha256)
        || copyPastePromptSha256 !== stringSha256(copyPastePrompt)
        || !/^[0-9a-f]{64}$/.test(launchInputSha256)
    ) {
        return false;
    }
    if (launchInputMode === 'copy_paste_prompt') {
        return launchInputSha256 === copyPastePromptSha256;
    }
    if (launchInputMode === 'launch_artifact_path') {
        return Boolean(
            launchInputArtifactPath
            && /^[0-9a-f]{64}$/.test(launchInputArtifactSha256)
            && /^[0-9a-f]{64}$/.test(preparedLaunchArtifactSha256)
            && launchInputArtifactSha256 === preparedLaunchArtifactSha256
            && launchInputSha256 === preparedLaunchArtifactSha256
        );
    }
    return false;
}

export function hasCompletedReviewerLaunchEvidence(launchArtifact: Record<string, unknown>): boolean {
    const providerInvocationId = getArtifactStringField(
        launchArtifact,
        'provider_invocation_id',
        'providerInvocationId',
        'controller_invocation_id',
        'controllerInvocationId'
    );
    const freshContext = launchArtifact.fresh_context === true
        || launchArtifact.freshContext === true
        || launchArtifact.isolated_context === true
        || launchArtifact.isolatedContext === true
        || launchArtifact.fork_context === false
        || launchArtifact.forkContext === false;
    const delegationStartedAtUtc = getArtifactStringField(
        launchArtifact,
        'delegation_started_at_utc',
        'delegationStartedAtUtc'
    );
    const launchedAtUtc = getArtifactStringField(launchArtifact, 'launched_at_utc', 'launchedAtUtc');
    return Boolean(
        getArtifactStringField(launchArtifact, 'launch_tool', 'launchTool')
        && providerInvocationId
        && delegationStartedAtUtc
        && launchedAtUtc
        && launchedAtUtc === delegationStartedAtUtc
        && freshContext
        && hasReviewerLaunchInputEvidence(launchArtifact)
    );
}

export function hasDelegationStartedEvidence(launchArtifact: Record<string, unknown>): boolean {
    const providerInvocationId = getArtifactStringField(
        launchArtifact,
        'provider_invocation_id',
        'providerInvocationId',
        'controller_invocation_id',
        'controllerInvocationId'
    );
    const freshContext = launchArtifact.fresh_context === true
        || launchArtifact.freshContext === true
        || launchArtifact.isolated_context === true
        || launchArtifact.isolatedContext === true
        || launchArtifact.fork_context === false
        || launchArtifact.forkContext === false;
    return Boolean(
        getArtifactStringField(launchArtifact, 'launch_tool', 'launchTool')
        && providerInvocationId
        && getArtifactStringField(launchArtifact, 'delegation_started_at_utc', 'delegationStartedAtUtc')
        && getArtifactStringField(launchArtifact, 'launched_at_utc', 'launchedAtUtc')
        && freshContext
        && hasReviewerLaunchInputEvidence(launchArtifact)
    );
}
