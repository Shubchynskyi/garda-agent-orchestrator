import {
    assert,
    createTempRepo,
    describe,
    fileSha256ForTest,
    fs,
    it,
    launchArtifactInputArgsForTest,
    path,
    prepareReviewerLaunchForTest,
    readTaskTimelineEvents,
    recordReviewerDelegationStartedForTest,
    runCliMainWithHandling,
    runCliWithCapturedOutput,
    seedPromptBoundReviewFixture,
    seedRoutedReviewerLaunchFixture
} from './gates-command-review-launch-fixtures';
import { buildRecordReviewResultCommand } from '../../../../../../src/cli/commands/gate-review-handlers/launch/reviewer-handoff-support';

describe('cli/commands/gates review launch completion', () => {
    it('record-review-result handoff command single-quotes shell-substitution metacharacters', () => {
        const command = buildRecordReviewResultCommand({
            repoRoot: 'D:/repo',
            taskId: 'T-716',
            reviewType: 'security',
            reviewerExecutionMode: 'delegated_subagent',
            reviewerIdentity: 'agent:reviewer-$(whoami)`x`"q";echo pwn;\'tail',
            preflightPath: 'D:/repo/garda-agent-orchestrator/runtime/reviews/T-716-preflight.json',
            reviewContextPath: 'D:/repo/garda-agent-orchestrator/runtime/reviews/T-716-security-review-context.json',
            reviewOutputPath: 'D:/repo/garda-agent-orchestrator/runtime/tmp/reviews/T-716/security/review-output-$(whoami)`x`"q";touch pwn;\'tail.md'
        });

        assert.ok(command.includes("--review-output-path 'garda-agent-orchestrator/runtime/tmp/reviews/T-716/security/review-output-$(whoami)`x`\"q\";touch pwn;''tail.md'"));
        assert.ok(command.includes("--reviewer-identity 'agent:reviewer-$(whoami)`x`\"q\";echo pwn;''tail'"));
        assert.ok(!command.includes('--review-output-path "'));
        assert.ok(!command.includes('--reviewer-identity "'));
    });

    it('complete-reviewer-launch rejects stale reviewer prompt artifacts after preparation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-stale-prompt-complete';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });

        fs.writeFileSync(fixture.reviewerPromptPath, 'stale reviewer prompt payload before completion\n', 'utf8');
        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-265-complete',
            '--attestation-source', 'test_provider_controller',
            '--fork-context', 'false'
        ], { cwd: repoRoot });

        assert.notEqual(complete.exitCode, 0);
        assert.ok(
            complete.errors.some((line) => line.includes('complete-reviewer-launch cannot continue because reviewer prompt artifact is stale')),
            complete.errors.join('\n')
        );
        const launchArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(launchArtifact.attestation_state, 'prepared');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch completes a prepared artifact that record-review-invocation accepts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-valid';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-305',
            attestationSource: 'claude_task_tool_launch'
        });

        const capturedLines: string[] = [];
        const originalConsoleLog = console.log;
        const previousCompleteExitCode = process.exitCode;
        const previousCompleteCwd = process.cwd();
        process.exitCode = 0;
        let observedCompleteExitCode = 0;
        console.log = (...args: unknown[]) => capturedLines.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                ...launchArtifactInputArgsForTest(launchArtifactPath),
                '--fork-context', 'false'
            ]);
            observedCompleteExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCompleteCwd);
            process.exitCode = previousCompleteExitCode;
        }

        assert.equal(observedCompleteExitCode, 0, `complete-reviewer-launch should succeed, got exit code ${observedCompleteExitCode}`);
        assert.ok(capturedLines.some((line) => line.includes('REVIEWER_LAUNCH_COMPLETED: code')));

        const completedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(completedArtifact.attestation_state, 'launched', 'Artifact state should be launched');
        assert.equal(completedArtifact.evidence_type, 'delegated_reviewer_launch', 'Evidence type should be updated');
        assert.equal(completedArtifact.attestation_source, 'claude_task_tool_launch', 'Attestation source should be set');
        assert.equal(completedArtifact.provider_invocation_id, 'test-invocation-305', 'Provider invocation ID should be set');
        assert.equal(typeof completedArtifact.launched_at_utc, 'string', 'Launched timestamp should be set by the gate');
        assert.equal(Number.isNaN(Date.parse(completedArtifact.launched_at_utc)), false);
        assert.equal(typeof completedArtifact.launch_prepared_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(completedArtifact.launch_prepared_at_utc)), false);
        assert.equal(typeof completedArtifact.launch_completed_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(completedArtifact.launch_completed_at_utc)), false);
        assert.equal(completedArtifact.fork_context, false, 'Fork context should be false');
        assert.equal(completedArtifact.launch_input_mode, 'launch_artifact_path');
        assert.equal(completedArtifact.launch_input_artifact_path, launchArtifactPath.replace(/\\/g, '/'));
        assert.equal(completedArtifact.launch_input_sha256, completedArtifact.prepared_reviewer_launch_artifact_sha256);
        assert.equal(completedArtifact.launch_input_artifact_sha256, completedArtifact.prepared_reviewer_launch_artifact_sha256);
        assert.equal(typeof completedArtifact.copy_paste_reviewer_launch_prompt_sha256, 'string');
        assert.equal(completedArtifact.launch_input_copy_paste_reviewer_launch_prompt_sha256, completedArtifact.copy_paste_reviewer_launch_prompt_sha256);
        assert.ok(capturedLines.some((line) => line.includes('LaunchInputMode: launch_artifact_path')));
        assert.ok(capturedLines.some((line) => line.includes(`LaunchInputArtifactPath: ${launchArtifactPath.replace(/\\/g, '/')}`)));

        const previousInvokeExitCode = process.exitCode;
        const previousInvokeCwd = process.cwd();
        process.exitCode = 0;
        let observedInvokeExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'record-review-invocation',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            observedInvokeExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousInvokeCwd);
            process.exitCode = previousInvokeExitCode;
        }

        assert.equal(observedInvokeExitCode, 0, `record-review-invocation should accept the completed artifact, got exit code ${observedInvokeExitCode}`);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 1);
        const invocationEvent = events.find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        const invocationDetails = invocationEvent?.details as Record<string, unknown> | undefined;
        assert.equal(invocationDetails?.launch_prepared_at_utc, completedArtifact.launch_prepared_at_utc);
        assert.equal(invocationDetails?.launched_at_utc, completedArtifact.launched_at_utc);
        assert.equal(invocationDetails?.launch_completed_at_utc, completedArtifact.launch_completed_at_utc);
        assert.equal(invocationDetails?.launch_input_mode, completedArtifact.launch_input_mode);
        assert.equal(invocationDetails?.launch_input_sha256, completedArtifact.launch_input_sha256);
        assert.equal(
            invocationDetails?.copy_paste_reviewer_launch_prompt_sha256,
            completedArtifact.copy_paste_reviewer_launch_prompt_sha256
        );
        assert.equal(typeof invocationDetails?.invocation_attested_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(String(invocationDetails?.invocation_attested_at_utc))), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-reviewer-delegation-started records real reviewer start before launch completion', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-693-delegation-started';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = fixture.launchArtifactPath;
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath
        });

        const started = await runCliWithCapturedOutput([
            'gate',
            'record-reviewer-delegation-started',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', 'cursor-subagent-T-693-code',
            '--attestation-source', 'cursor_subagent',
            ...launchArtifactInputArgsForTest(launchArtifactPath),
            '--fork-context', 'false'
        ], { cwd: repoRoot });

        assert.equal(started.exitCode, 0, started.errors.join('\n'));
        assert.ok(started.logs.some((line) => line.includes('REVIEWER_DELEGATION_STARTED: code')));
        const startedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(startedArtifact.attestation_state, 'delegation_started');
        assert.equal(startedArtifact.provider_invocation_id, 'cursor-subagent-T-693-code');
        assert.equal(typeof startedArtifact.delegation_started_at_utc, 'string');
        assert.equal(startedArtifact.launched_at_utc, startedArtifact.delegation_started_at_utc);
        assert.equal(startedArtifact.launch_input_mode, 'launch_artifact_path');

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const startedEvent = events.find((event) => event.event_type === 'REVIEWER_DELEGATION_STARTED');
        assert.ok(startedEvent);
        assert.equal((startedEvent.details as Record<string, unknown>).provider_invocation_id, 'cursor-subagent-T-693-code');
        assert.equal(
            (startedEvent.details as Record<string, unknown>).delegation_started_at_utc,
            startedArtifact.delegation_started_at_utc
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch preserves immutable launch input artifact provenance', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-680-launch-input-artifact';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = fixture.launchArtifactPath;
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath
        });

        const preparedLaunchArtifactSha256 = fileSha256ForTest(launchArtifactPath);
        const preparedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        const launchInputArtifactPath = String(preparedArtifact.reviewer_launch_input_artifact_path);
        const pinnedInputArtifactSha256 = String(preparedArtifact.reviewer_launch_input_artifact_sha256);
        assert.ok(launchInputArtifactPath.endsWith('/reviewer-launch-input.json'));
        assert.equal(fileSha256ForTest(launchInputArtifactPath), pinnedInputArtifactSha256);
        assert.notEqual(preparedLaunchArtifactSha256, pinnedInputArtifactSha256);
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-680-input',
            attestationSource: 'codex_spawn_agent'
        });

        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-680-input',
            '--attestation-source', 'codex_spawn_agent',
            '--launch-input-mode', 'launch_artifact_path',
            '--launch-input-artifact-path', launchInputArtifactPath,
            '--launch-input-sha256', pinnedInputArtifactSha256,
            '--fork-context', 'false',
            '--record-invocation'
        ], { cwd: repoRoot });

        assert.equal(complete.exitCode, 0, complete.errors.join('\n'));
        const completedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        const completedLaunchArtifactSha256 = fileSha256ForTest(launchArtifactPath);
        assert.notEqual(completedLaunchArtifactSha256, preparedLaunchArtifactSha256);
        assert.equal(fileSha256ForTest(launchInputArtifactPath), pinnedInputArtifactSha256);
        assert.equal(completedArtifact.launch_input_artifact_path, launchInputArtifactPath);
        assert.equal(completedArtifact.launch_input_artifact_sha256, pinnedInputArtifactSha256);
        assert.equal(completedArtifact.prepared_reviewer_launch_artifact_sha256, pinnedInputArtifactSha256);
        assert.ok(complete.logs.some((line) => line.includes(`LaunchArtifactSha256: ${completedLaunchArtifactSha256}`)));
        assert.ok(complete.logs.some((line) => line.includes(`LaunchInputArtifactPath: ${launchInputArtifactPath}`)));
        assert.ok(complete.logs.some((line) => line.includes(`LaunchInputArtifactSha256: ${pinnedInputArtifactSha256}`)));
        const recordResultCommand = complete.logs.find((line) => line.startsWith('RecordReviewResultCommand: ')) || '';
        const reviewOutputPath = String(completedArtifact.review_output_path);
        assert.ok(recordResultCommand.includes('node bin/garda.js gate record-review-result'));
        assert.ok(recordResultCommand.includes(`--task-id '${taskId}'`));
        assert.ok(recordResultCommand.includes("--review-type 'code'"));
        assert.ok(recordResultCommand.includes(`--preflight-path '${path.relative(repoRoot, fixture.preflightPath).replace(/\\/g, '/')}'`));
        assert.ok(recordResultCommand.includes(`--review-context-path '${path.relative(repoRoot, fixture.reviewContextPath).replace(/\\/g, '/')}'`));
        assert.ok(recordResultCommand.includes(`--review-output-path '${path.relative(repoRoot, reviewOutputPath).replace(/\\/g, '/')}'`));
        assert.ok(recordResultCommand.includes("--reviewer-execution-mode 'delegated_subagent'"));
        assert.ok(recordResultCommand.includes(`--reviewer-identity '${fixture.reviewerIdentity}'`));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch prints an explicit placeholder when review output path is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-716-missing-output-source';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = fixture.launchArtifactPath;
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath
        });
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-716-missing-output',
            attestationSource: 'codex_spawn_agent'
        });

        const artifactWithoutOutputPath = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        delete artifactWithoutOutputPath.review_output_path;
        delete artifactWithoutOutputPath.reviewOutputPath;
        fs.writeFileSync(launchArtifactPath, JSON.stringify(artifactWithoutOutputPath, null, 2) + '\n', 'utf8');

        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-716-missing-output',
            '--attestation-source', 'codex_spawn_agent',
            ...launchArtifactInputArgsForTest(launchArtifactPath),
            '--fork-context', 'false',
            '--record-invocation'
        ], { cwd: repoRoot });

        assert.equal(complete.exitCode, 0, complete.errors.join('\n'));
        const recordResultCommand = complete.logs.find((line) => line.startsWith('RecordReviewResultCommand: ')) || '';
        assert.ok(recordResultCommand.includes("--review-output-path '<ReviewOutputPath>'"), recordResultCommand);
        assert.ok(!recordResultCommand.includes('--review-output-stdin'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch does not print record-review-result when canonical preflight is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-716-missing-preflight';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = fixture.launchArtifactPath;
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath
        });
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-716-missing-preflight',
            attestationSource: 'codex_spawn_agent'
        });
        fs.rmSync(fixture.preflightPath, { force: true });

        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-716-missing-preflight',
            '--attestation-source', 'codex_spawn_agent',
            ...launchArtifactInputArgsForTest(launchArtifactPath),
            '--fork-context', 'false',
            '--record-invocation'
        ], { cwd: repoRoot });

        assert.notEqual(complete.exitCode, 0);
        assert.equal(complete.logs.some((line) => line.startsWith('RecordReviewResultCommand: ')), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects missing reviewer identity before printing record-review-result', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-716-missing-reviewer-identity';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = fixture.launchArtifactPath;
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath
        });
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-716-missing-identity',
            attestationSource: 'codex_spawn_agent'
        });

        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-716-missing-identity',
            '--attestation-source', 'codex_spawn_agent',
            ...launchArtifactInputArgsForTest(launchArtifactPath),
            '--fork-context', 'false',
            '--record-invocation'
        ], { cwd: repoRoot });

        assert.notEqual(complete.exitCode, 0);
        assert.equal(complete.logs.some((line) => line.startsWith('RecordReviewResultCommand: ')), false);
        assert.ok(complete.errors.some((line) => line.includes('ReviewerIdentity is required')), complete.errors.join('\n'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects missing launch input evidence for prepared prompts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-677-launch-input-missing';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = fixture.launchArtifactPath;
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath
        });
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-677-missing',
            attestationSource: 'codex_spawn_agent'
        });
        const artifactWithoutLaunchInput = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        delete artifactWithoutLaunchInput.launch_input_mode;
        delete artifactWithoutLaunchInput.launch_input_sha256;
        fs.writeFileSync(launchArtifactPath, JSON.stringify(artifactWithoutLaunchInput, null, 2) + '\n', 'utf8');

        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-677-missing',
            '--attestation-source', 'codex_spawn_agent',
            '--fork-context', 'false'
        ], { cwd: repoRoot });

        assert.notEqual(complete.exitCode, 0);
        assert.ok(complete.errors.some((line) => line.includes('launch_input_mode is required')), complete.errors.join('\n'));
        assert.ok(complete.errors.some((line) => line.includes('launch_input_sha256 is required')), complete.errors.join('\n'));
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(artifact.attestation_state, 'delegation_started');
        assert.equal(artifact.provider_invocation_id, 'test-invocation-677-missing');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects mismatched launch artifact input hash', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-677-launch-input-stale';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = fixture.launchArtifactPath;
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath
        });
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-677-stale',
            attestationSource: 'codex_spawn_agent'
        });

        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-677-stale',
            '--attestation-source', 'codex_spawn_agent',
            '--launch-input-mode', 'launch_artifact_path',
            '--launch-input-artifact-path', launchArtifactPath,
            '--launch-input-sha256', '0'.repeat(64),
            '--fork-context', 'false'
        ], { cwd: repoRoot });

        assert.notEqual(complete.exitCode, 0);
        assert.ok(
            complete.errors.some((line) => line.includes('launch_input_sha256 must match the selected reviewer launch input artifact sha256')),
            complete.errors.join('\n')
        );
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(artifact.attestation_state, 'delegation_started');
        assert.equal(artifact.provider_invocation_id, 'test-invocation-677-stale');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch can immediately attest invocation for provider-native launches', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-660-complete-launch-records-invocation';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-660',
            attestationSource: 'copilot_task_tool_launch'
        });

        const capturedLines: string[] = [];
        const originalConsoleLog = console.log;
        const previousCompleteExitCode = process.exitCode;
        const previousCompleteCwd = process.cwd();
        process.exitCode = 0;
        let observedCompleteExitCode = 0;
        console.log = (...args: unknown[]) => capturedLines.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-660',
                '--attestation-source', 'copilot_task_tool_launch',
                ...launchArtifactInputArgsForTest(launchArtifactPath),
                '--fork-context', 'false',
                '--record-invocation'
            ]);
            observedCompleteExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCompleteCwd);
            process.exitCode = previousCompleteExitCode;
        }

        assert.equal(observedCompleteExitCode, 0);
        assert.ok(capturedLines.some((line) => line.includes('REVIEWER_LAUNCH_COMPLETED: code')));
        assert.ok(capturedLines.some((line) => line.includes('REVIEWER_INVOCATION_ATTESTED: code')));
        assert.ok(capturedLines.some((line) => line.includes('record-review-invocation was attested by complete-reviewer-launch')));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 1);
        const completedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(completedArtifact.provider_invocation_id, 'test-invocation-660');
        assert.equal(completedArtifact.fork_context, false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects tampered prepared launch bindings and leaves artifact unchanged', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-complete-launch-binding-tamper';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        await prepareReviewerLaunchForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath: fixture.launchArtifactPath
        });
        const preparedArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(fixture.launchArtifactPath, JSON.stringify({
            ...preparedArtifact,
            launch_binding_sha256: '0'.repeat(64)
        }, null, 2) + '\n', 'utf8');

        const complete = await runCliWithCapturedOutput([
            'gate',
            'complete-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-265-binding',
            '--attestation-source', 'test_provider_controller',
            '--fork-context', 'false'
        ], { cwd: repoRoot });

        assert.notEqual(complete.exitCode, 0);
        assert.ok(
            complete.errors.some((line) => line.includes('launch_binding_sha256 must match the current prepared launch binding')),
            complete.errors.join('\n')
        );
        const artifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(artifact.attestation_state, 'prepared');
        assert.equal(artifact.provider_invocation_id, undefined);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects missing provider invocation id and leaves artifact unchanged', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-missing-id';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-305',
            attestationSource: 'claude_task_tool_launch'
        });
        const artifactWithoutInvocationId = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        delete artifactWithoutInvocationId.provider_invocation_id;
        delete artifactWithoutInvocationId.controller_invocation_id;
        fs.writeFileSync(launchArtifactPath, JSON.stringify(artifactWithoutInvocationId, null, 2) + '\n', 'utf8');

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('ProviderInvocationId or ControllerInvocationId is required')));
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'delegation_started', 'Artifact should remain in delegation_started state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects stale context hash when review context changed after prepare', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-stale-hash';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        // Mutate the review context so its SHA256 no longer matches the prepared artifact
        fs.writeFileSync(fixture.reviewContextPath, fs.readFileSync(fixture.reviewContextPath, 'utf8') + '\n', 'utf8');

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(
            capturedErrors.some((line) => line.includes('review_context_sha256 must match the current review context')),
            'Expected error about stale review context sha256'
        );
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects stale routing hash when prepared artifact no longer matches routing telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-stale-routing';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const preparedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        fs.writeFileSync(
            launchArtifactPath,
            JSON.stringify({ ...preparedArtifact, routing_event_sha256: '0'.repeat(64) }, null, 2),
            'utf8'
        );

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(
            capturedErrors.some((line) => line.includes('routing_event_sha256 must match the current routing event')),
            'Expected error about stale routing event sha256'
        );
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects when both provider and controller invocation ids are provided', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-both-ids';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'provider-id-305',
                '--controller-invocation-id', 'controller-id-305',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('not both')));
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects forbidden attestation source', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-bad-source';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'Manual',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('not a valid provider/controller-owned attestation source')));
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects missing attestation source', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-missing-source';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('AttestationSource is required')));
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects when no fresh-context flag is provided', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-no-ctx';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.ok(capturedErrors.some((line) => line.includes('At least one of --fresh-context, --isolated-context, or --fork-context false')));
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'prepared', 'Artifact should remain in prepared state after failed complete');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch succeeds with controller-invocation-id and writes correct artifact field', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-controller-id';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            controllerInvocationId: 'ctrl-invocation-305',
            attestationSource: 'claude_task_tool_launch'
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--controller-invocation-id', 'ctrl-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                ...launchArtifactInputArgsForTest(launchArtifactPath),
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0, `complete-reviewer-launch with controller id should succeed, got ${observedExitCode}`);
        const completedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(completedArtifact.attestation_state, 'launched');
        assert.equal(completedArtifact.controller_invocation_id, 'ctrl-invocation-305', 'Controller invocation ID should be set');
        assert.equal(completedArtifact.provider_invocation_id, undefined, 'Provider invocation ID should not be set');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch writes fresh_context and isolated_context fields when flags provided', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-ctx-flags';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-305',
            attestationSource: 'claude_task_tool_launch'
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                ...launchArtifactInputArgsForTest(launchArtifactPath),
                '--fresh-context',
                '--isolated-context'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0, `complete-reviewer-launch with fresh+isolated context should succeed, got ${observedExitCode}`);
        const completedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(completedArtifact.attestation_state, 'launched');
        assert.equal(completedArtifact.fresh_context, true, 'fresh_context should be set to true');
        assert.equal(completedArtifact.isolated_context, true, 'isolated_context should be set to true');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch records gate-owned launched-at-utc when the flag is omitted', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-305-complete-launch-no-utc';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-305',
            attestationSource: 'claude_task_tool_launch'
        });

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--attestation-source', 'claude_task_tool_launch',
                ...launchArtifactInputArgsForTest(launchArtifactPath),
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0, `Expected complete-reviewer-launch to succeed, got ${observedExitCode}: ${capturedErrors.join('\n')}`);
        const artifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(artifact.attestation_state, 'launched', 'Artifact should be completed');
        assert.equal(typeof artifact.launched_at_utc, 'string', 'Gate should write launched_at_utc');
        assert.equal(Number.isNaN(Date.parse(artifact.launched_at_utc)), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('complete-reviewer-launch rejects caller-supplied launched-at-utc as spoof-like input', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-257-complete-launch-spoof-utc';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousPrepareExitCode = process.exitCode;
        const previousPrepareCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousPrepareCwd);
            process.exitCode = previousPrepareExitCode;
        }

        const capturedErrors: string[] = [];
        const originalConsoleError = console.error;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => capturedErrors.push(args.map(String).join(' '));
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate', 'complete-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity,
                '--reviewer-launch-artifact-path', launchArtifactPath,
                '--provider-invocation-id', 'test-invocation-305',
                '--launched-at-utc', '2026-05-18T12:34:56.789Z',
                '--attestation-source', 'claude_task_tool_launch',
                '--fork-context', 'false'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0, 'Expected complete-reviewer-launch to reject caller-owned launched-at-utc');
        assert.match(capturedErrors.join('\n'), /spoof-like launch freshness input/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
