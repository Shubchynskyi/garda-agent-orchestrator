import {
    assert,
    buildReviewContext,
    createHash,
    createTempRepo,
    describe,
    fileSha256ForTest,
    fs,
    getReviewsRoot,
    getWorkspaceSnapshot,
    initializeGitRepo,
    it,
    os,
    path,
    prepareCurrentReviewPhase,
    readTaskTimelineEvents,
    runCliMainWithHandling,
    runCliWithCapturedOutput,
    runGit,
    seedInitAnswers,
    seedPromptBoundReviewFixture,
    seedRoutedReviewerLaunchFixture,
    seedTaskQueue,
    writePreflight
} from './gates-command-review-launch-fixtures';

describe('cli/commands/gates review launch prepared metadata', () => {
    it('prepare-reviewer-launch writes current prepared launch metadata without attesting invocation', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');
        const launchInputArtifactPath = path.join(path.dirname(launchArtifactPath), 'reviewer-launch-input.json');
        const legacyReviewOutputPath = path.join(path.dirname(launchArtifactPath), 'review-output.md');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(path.join(repoRoot, 'src'));
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(launchArtifactPath), true);
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        const reviewOutputPath = String(launchArtifact.review_output_path);
        assert.equal(launchArtifact.schema_version, 1);
        assert.equal(launchArtifact.evidence_type, 'delegated_reviewer_launch_preparation');
        assert.equal(launchArtifact.attestation_state, 'prepared');
        assert.equal(launchArtifact.task_id, taskId);
        assert.equal(launchArtifact.review_type, 'code');
        assert.equal(launchArtifact.reviewer_identity, fixture.reviewerIdentity);
        assert.equal(launchArtifact.review_context_sha256, fixture.reviewContextSha256);
        assert.equal(launchArtifact.review_tree_state_sha256, fixture.reviewTreeStateSha256);
        assert.equal(launchArtifact.review_tree_state.tree_state_sha256, fixture.reviewTreeStateSha256);
        assert.equal(launchArtifact.routing_event_sha256, fixture.routingEventSha256);
        assert.equal(launchArtifact.reviewer_prompt_path, fixture.reviewerPromptPath.replace(/\\/g, '/'));
        assert.equal(launchArtifact.role_prompt_path, fixture.rolePromptPath.replace(/\\/g, '/'));
        assert.equal(launchArtifact.prompt_template_path, fixture.promptTemplatePath.replace(/\\/g, '/'));
        assert.equal(launchArtifact.output_template_path, fixture.outputTemplatePath.replace(/\\/g, '/'));
        assert.equal(launchArtifact.evidence_manifest_path, fixture.evidenceManifestPath.replace(/\\/g, '/'));
        assert.match(path.basename(reviewOutputPath), /^review-output-[0-9a-f]{16}\.md$/);
        assert.notEqual(reviewOutputPath, legacyReviewOutputPath.replace(/\\/g, '/'));
        assert.equal(launchArtifact.review_output_path, reviewOutputPath);
        assert.equal(typeof launchArtifact.review_output_attempt_sha256, 'string');
        assert.match(launchArtifact.review_output_attempt_sha256, /^[0-9a-f]{64}$/);
        assert.equal(launchArtifact.reviewer_launch_artifact_path, launchArtifactPath.replace(/\\/g, '/'));
        assert.equal(launchArtifact.reviewer_launch_input_artifact_path, launchInputArtifactPath.replace(/\\/g, '/'));
        const rolePromptSha256 = createHash('sha256').update(fs.readFileSync(fixture.rolePromptPath)).digest('hex');
        const promptTemplateSha256 = createHash('sha256').update(fs.readFileSync(fixture.promptTemplatePath)).digest('hex');
        const outputTemplateSha256 = createHash('sha256').update(fs.readFileSync(fixture.outputTemplatePath)).digest('hex');
        const evidenceManifestSha256 = createHash('sha256').update(fs.readFileSync(fixture.evidenceManifestPath)).digest('hex');
        const copyPastePromptSha256 = createHash('sha256')
            .update(String(launchArtifact.copy_paste_reviewer_launch_prompt), 'utf8')
            .digest('hex');
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('First open and read RolePromptPath:'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(fixture.rolePromptPath.replace(/\\/g, '/')));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(`RolePromptSha256: ${rolePromptSha256}`));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Then open and read PromptTemplatePath:'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(fixture.promptTemplatePath.replace(/\\/g, '/')));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(`PromptTemplateSha256: ${promptTemplateSha256}`));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Then open and read ReviewerPromptPath:'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(fixture.reviewerPromptPath.replace(/\\/g, '/')));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(`ReviewerPromptSha256: ${fixture.reviewerPromptSha256}`));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Use EvidenceManifestPath to locate the review context, scoped diff, and supporting evidence:'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(fixture.evidenceManifestPath.replace(/\\/g, '/')));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(`EvidenceManifestSha256: ${evidenceManifestSha256}`));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Fill OutputTemplatePath exactly, preserving the required sections:'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(fixture.outputTemplatePath.replace(/\\/g, '/')));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(`OutputTemplateSha256: ${outputTemplateSha256}`));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Required sections: Validation Notes, Findings by Severity, Deferred Findings, Residual Risks, Verdict.'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(reviewOutputPath.replace(/\\/g, '/')));
        assert.equal(launchArtifact.copy_paste_reviewer_launch_prompt_sha256, copyPastePromptSha256);
        assert.equal(launchArtifact.role_prompt_sha256, rolePromptSha256);
        assert.equal(launchArtifact.prompt_template_sha256, promptTemplateSha256);
        assert.equal(launchArtifact.output_template_sha256, outputTemplateSha256);
        assert.equal(launchArtifact.evidence_manifest_sha256, evidenceManifestSha256);
        assert.equal(launchArtifact.attestation_source, 'garda_prepare_reviewer_launch');
        assert.equal(typeof launchArtifact.launch_binding_sha256, 'string');
        assert.ok(launchArtifact.launch_binding_sha256.length > 0);
        assert.equal(typeof launchArtifact.launch_prepared_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(launchArtifact.launch_prepared_at_utc)), false);
        assert.equal(launchArtifact.generated_at_utc, launchArtifact.launch_prepared_at_utc);
        assert.equal(launchArtifact.launch_completion_token, undefined);
        assert.equal(launchArtifact.controller_launch_completion_token, undefined);
        assert.equal(typeof launchArtifact.prepared_launch_event_sha256, 'string');
        assert.ok(launchArtifact.prepared_launch_event_sha256.length > 0);
        assert.equal(typeof launchArtifact.reviewer_launch_prepared_event_recorded_at_utc, 'string');
        assert.equal(Number.isNaN(Date.parse(launchArtifact.reviewer_launch_prepared_event_recorded_at_utc)), false);
        assert.equal(typeof launchArtifact.launch_tool, 'string');
        assert.ok(String(launchArtifact.launch_tool).length > 0);
        assert.equal(
            launchArtifact.local_trust_boundary,
            'Local reviewer launch artifacts are convenience metadata for a real delegated reviewer launch; they are not non-forgeable proof without provider-owned recording.'
        );
        assert.equal(launchArtifact.after_launch_required_updates.evidence_type, 'delegated_reviewer_launch');
        assert.equal(launchArtifact.after_launch_required_updates.attestation_state, 'launched');
        assert.equal(launchArtifact.after_launch_required_updates.provider_invocation_id_or_controller_invocation_id, '<actual delegated reviewer invocation id>');
        assert.equal(launchArtifact.after_launch_required_updates.launch_completed_at_utc, '<gate-owned ISO-8601 completion timestamp>');
        assert.equal(launchArtifact.after_launch_required_updates.launch_input_mode, 'launch_artifact_path or copy_paste_prompt');
        assert.equal(launchArtifact.after_launch_required_updates.launch_input_sha256, '<ReviewerLaunchInputArtifactSha256 for launch_artifact_path, or CopyPasteReviewerLaunchPromptSha256>');
        assert.equal(launchArtifact.after_launch_required_updates.launch_input_artifact_path, '<ReviewerLaunchInputArtifactPath when launch_input_mode is launch_artifact_path>');
        assert.equal(launchArtifact.after_launch_required_updates.launch_input_artifact_sha256, '<ReviewerLaunchInputArtifactSha256 when launch_input_mode is launch_artifact_path>');
        assert.equal(launchArtifact.after_launch_required_updates.copy_paste_reviewer_launch_prompt_sha256, copyPastePromptSha256);
        assert.equal(fs.existsSync(launchInputArtifactPath), true);
        const pinnedInputArtifactSha256 = String(launchArtifact.reviewer_launch_input_artifact_sha256);
        assert.equal(fileSha256ForTest(launchInputArtifactPath), pinnedInputArtifactSha256);
        assert.notEqual(fileSha256ForTest(launchArtifactPath), pinnedInputArtifactSha256);
        assert.deepEqual(launchArtifact.preserve_prepared_fields, [
            'review_context_sha256',
            'routing_event_sha256',
            'reviewer_prompt_sha256',
            'role_prompt_sha256',
            'prompt_template_sha256',
            'output_template_sha256',
            'evidence_manifest_sha256',
            'copy_paste_reviewer_launch_prompt_sha256',
            'review_output_attempt_sha256',
            'review_tree_state_sha256',
            'launch_binding_sha256',
            'prepared_launch_event_sha256',
            'prepared_launch_event_task_sequence',
            'reviewer_launch_input_artifact_sha256'
        ]);
        assert.ok(String(launchArtifact.record_invocation_command).includes('gate record-review-invocation'));
        assert.ok(String(launchArtifact.record_invocation_command).includes(`--reviewer-identity "${fixture.reviewerIdentity}"`));
        assert.ok(String(launchArtifact.next_action).includes('Launch a real subagent using built-in tools'));
        assert.ok(String(launchArtifact.next_action).includes('if for some reason that is impossible right now, you must stop and report this to the user'));
        assert.ok(String(launchArtifact.next_action).includes('this is expected behavior in this repository'));
        assert.ok(String(launchArtifact.next_action).includes('keep that clean-context session in standby'));
        assert.ok(String(launchArtifact.next_action).includes('resume it and send the exact ReviewerLaunchInputArtifactPath'));
        assert.ok(String(launchArtifact.next_action).includes('standby completion before launch input delivery is expected provider handshake noise, not review evidence'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const launchPreparedEvent = events.find((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED');
        const launchPreparedIntegrity = launchPreparedEvent?.integrity as { event_sha256?: string } | undefined;
        const launchPreparedDetails = launchPreparedEvent?.details as Record<string, unknown> | undefined;
        assert.equal(launchPreparedIntegrity?.event_sha256, launchArtifact.prepared_launch_event_sha256);
        assert.equal(launchPreparedDetails?.launch_prepared_at_utc, launchArtifact.launch_prepared_at_utc);
        assert.equal(launchPreparedDetails?.reviewer_launch_input_artifact_path, launchInputArtifactPath.replace(/\\/g, '/'));
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        assert.ok(capturedLogs.some((line) => line.includes('REVIEWER_LAUNCH_PREPARED: code')));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewContextSha256: ${fixture.reviewContextSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewTreeStateSha256: ${fixture.reviewTreeStateSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`RoutingEventSha256: ${fixture.routingEventSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`RepoRoot: ${repoRoot.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewContextPath: ${fixture.reviewContextPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`RolePromptPath: ${fixture.rolePromptPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewerPromptPath: ${fixture.reviewerPromptPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`PromptTemplatePath: ${fixture.promptTemplatePath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`OutputTemplatePath: ${fixture.outputTemplatePath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`EvidenceManifestPath: ${fixture.evidenceManifestPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewOutputPath: ${reviewOutputPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ScopedDiffMetadataPath: ${path.join(getReviewsRoot(repoRoot), `${taskId}-code-scoped.json`).replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewerLaunchArtifactPath: ${launchArtifactPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewerLaunchInputArtifactPath: ${launchInputArtifactPath.replace(/\\/g, '/')}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewerLaunchInputArtifactSha256: ${fileSha256ForTest(launchInputArtifactPath)}`)));
        assert.ok(capturedLogs.some((line) => line.includes(`CopyPasteReviewerLaunchPromptSha256: ${copyPastePromptSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('LaunchInputCliFlagHelp: for launch_artifact_path mode, pass ReviewerLaunchInputArtifactSha256 to --launch-input-sha256')));
        assert.ok(capturedLogs.some((line) => line.includes('launch_input_sha256 and launch_input_artifact_sha256 are artifact JSON fields, not CLI flags')));
        assert.equal(capturedLogs.some((line) => line.includes('LaunchCompletionToken:')), false);
        assert.equal(capturedLogs.some((line) => line.includes('LaunchCompletionTokenSha256:')), false);
        assert.ok(capturedLogs.some((line) => line.includes('PreparedLaunchEventSha256:')));
        assert.ok(capturedLogs.some((line) => line.includes('AttestationState: prepared')));
        assert.ok(capturedLogs.some((line) => line.includes('TrustBoundary: Local reviewer launch artifacts are convenience metadata')));
        assert.ok(capturedLogs.some((line) => line.includes('HandoffInstruction: Treat review context as an opaque handoff artifact')));
        assert.ok(capturedLogs.some((line) => line.includes('Do not open or summarize the generated review-context markdown')));
        assert.ok(capturedLogs.some((line) => line.includes('RequiredCompletedFields:')));
        assert.ok(capturedLogs.some((line) => line.includes('launch_input_sha256=<ReviewerLaunchInputArtifactSha256 for launch_artifact_path, or CopyPasteReviewerLaunchPromptSha256>')));
        assert.ok(capturedLogs.some((line) => line.includes('PreservePreparedFields: review_context_sha256')));
        assert.ok(capturedLogs.some((line) => line.includes('RecordInvocationCommand: node bin/garda.js gate record-review-invocation')));
        assert.ok(capturedLogs.some((line) => line.includes('CopyPasteReviewerLaunchPrompt:')));
        assert.ok(capturedLogs.some((line) => line.includes('First open and read RolePromptPath:')));
        assert.ok(capturedLogs.some((line) => line.includes(`RolePromptSha256: ${rolePromptSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('Then open and read PromptTemplatePath:')));
        assert.ok(capturedLogs.some((line) => line.includes(`PromptTemplateSha256: ${promptTemplateSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('Then open and read ReviewerPromptPath:')));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewerPromptSha256: ${fixture.reviewerPromptSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('Use EvidenceManifestPath to locate the review context, scoped diff, and supporting evidence:')));
        assert.ok(capturedLogs.some((line) => line.includes(`EvidenceManifestSha256: ${evidenceManifestSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('Fill OutputTemplatePath exactly, preserving the required sections:')));
        assert.ok(capturedLogs.some((line) => line.includes(`OutputTemplateSha256: ${outputTemplateSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('Required sections: Validation Notes, Findings by Severity, Deferred Findings, Residual Risks, Verdict.')));
        assert.ok(capturedLogs.some((line) => line.includes('Write the final review report to ReviewOutputPath when file writing is available')));
        assert.ok(capturedLogs.some((line) => line.includes('NextAction: launch the delegated reviewer with the exact CopyPasteReviewerLaunchPrompt or ReviewerLaunchInputArtifactPath')));
        assert.ok(capturedLogs.some((line) => line.includes('create or reserve a clean-context reviewer session first so the provider/controller assigns the agent:<id>')));
        assert.ok(capturedLogs.some((line) => line.includes('keep that clean-context session in standby')));
        assert.ok(capturedLogs.some((line) => line.includes('resume it and send the exact ReviewerLaunchInputArtifactPath')));
        assert.ok(capturedLogs.some((line) => line.includes('standby completion before launch input delivery is expected provider handshake noise, not review evidence')));
        assert.ok(capturedLogs.some((line) => line.includes('Launch a real subagent using built-in tools')));
        assert.ok(capturedLogs.some((line) => line.includes('if for some reason that is impossible right now, you must stop and report this to the user')));
        assert.ok(capturedLogs.some((line) => line.includes('this is expected behavior in this repository')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects stale staged review contexts after MM drift', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-staged-launch-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        initializeGitRepo(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const value = 2;\n', 'utf8');
        runGit(repoRoot, ['add', 'src/app.ts']);
        const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_staged_only',
            scope_category: 'code',
            changed_files: ['src/app.ts'],
            metrics: {
                changed_lines_total: stagedSnapshot.changed_lines_total,
                changed_files_sha256: stagedSnapshot.changed_files_sha256,
                scope_content_sha256: stagedSnapshot.scope_content_sha256,
                scope_sha256: stagedSnapshot.scope_sha256
            },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            triggers: { runtime_changed: true, runtime_code_changed: true }
        });
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const tokenConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        buildReviewContext({
            reviewType: 'code',
            depth: 2,
            preflightPath,
            tokenEconomyConfigPath: tokenConfigPath,
            scopedDiffMetadataPath: path.join(reviewsRoot, `${taskId}-code-scoped.json`),
            outputPath: reviewContextPath,
            repoRoot
        });

        const reviewerIdentity = 'agent:test-staged-drift-reviewer';
        const routing = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });
        assert.equal(routing.exitCode, 0, routing.errors.join('\n'));

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const value = 3;\n', 'utf8');
        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json')
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch cannot continue because the current reviewer-visible tree state is stale')),
            prepare.errors.join('\n')
        );
        assert.ok(
            prepare.errors.some((line) => line.includes('Staged review scope is stale: src/app.ts has unstaged working-tree changes')),
            prepare.errors.join('\n')
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects review contexts after full workspace scope drift', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-launch-scope-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# baseline\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const value = 2;\n', 'utf8');
        const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        assert.deepEqual(snapshot.changed_files, ['src/app.ts']);
        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_auto',
            scope_category: 'code',
            changed_files: snapshot.changed_files,
            metrics: {
                changed_lines_total: snapshot.changed_lines_total,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            triggers: { runtime_changed: true, runtime_code_changed: true }
        });
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const tokenConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        buildReviewContext({
            reviewType: 'code',
            depth: 2,
            preflightPath,
            tokenEconomyConfigPath: tokenConfigPath,
            scopedDiffMetadataPath: path.join(reviewsRoot, `${taskId}-code-scoped.json`),
            outputPath: reviewContextPath,
            repoRoot
        });

        const reviewerIdentity = 'agent:test-scope-drift-reviewer';
        const routing = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });
        assert.equal(routing.exitCode, 0, routing.errors.join('\n'));

        fs.writeFileSync(path.join(repoRoot, 'src', 'new-file.ts'), 'export const next = true;\n', 'utf8');
        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json')
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch cannot continue because review context scope is stale')),
            prepare.errors.join('\n')
        );
        assert.ok(
            prepare.errors.some((line) => line.includes('Missing from review context: [src/new-file.ts]')),
            prepare.errors.join('\n')
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects stale reviewer prompt artifacts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-stale-prompt-prepare';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });

        fs.writeFileSync(fixture.reviewerPromptPath, 'stale reviewer prompt payload\n', 'utf8');
        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch cannot continue because reviewer prompt artifact is stale')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects stale reviewer prompt-template artifacts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-556-stale-prompt-template-prepare';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });

        fs.writeFileSync(fixture.promptTemplatePath, 'stale reviewer prompt template payload\n', 'utf8');
        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch cannot continue because reviewer prompt template artifact is stale')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects prompt-template artifacts whose realpath escapes the repo root', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-556-prompt-template-realpath-escape';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${taskId}-external-`));
        const externalTemplatePath = path.join(externalRoot, 'prompt-template.md');
        const externalTemplateText = '# code review Prompt Template\nexternal prompt template payload\n';
        fs.writeFileSync(externalTemplatePath, externalTemplateText, 'utf8');
        const linkDir = path.join(getReviewsRoot(repoRoot), `${taskId}-linked-external`);
        fs.symlinkSync(externalRoot, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
        const linkedTemplatePath = path.join(linkDir, 'prompt-template.md');

        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerHandoff = reviewContext.reviewer_handoff as Record<string, Record<string, string>>;
        reviewerHandoff.prompt_template.artifact_path = linkedTemplatePath.replace(/\\/g, '/');
        reviewerHandoff.prompt_template.artifact_sha256 = createHash('sha256')
            .update(externalTemplateText, 'utf8')
            .digest('hex');
        fs.writeFileSync(fixture.reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch requires reviewer prompt template artifact to stay inside repo root')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(externalRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects prompt artifacts without a context hash binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-missing-prompt-binding';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        const ruleContext = reviewContext.rule_context as Record<string, unknown>;
        delete ruleContext.artifact_sha256;
        fs.writeFileSync(fixture.reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('prepare-reviewer-launch requires review context rule_context.artifact_sha256')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects prompt artifacts outside the repo root', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-prompt-outside-repo';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        const externalPromptPath = path.join(path.dirname(repoRoot), `${taskId}-outside-prompt.md`);
        const externalPromptContent = 'external reviewer prompt payload\n';
        fs.writeFileSync(externalPromptPath, externalPromptContent, 'utf8');
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        const ruleContext = reviewContext.rule_context as Record<string, unknown>;
        ruleContext.artifact_path = externalPromptPath.replace(/\\/g, '/');
        ruleContext.preferred_prompt_artifact = externalPromptPath.replace(/\\/g, '/');
        ruleContext.artifact_sha256 = createHash('sha256').update(externalPromptContent, 'utf8').digest('hex');
        fs.writeFileSync(fixture.reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('Path must stay inside repo root')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(externalPromptPath, { force: true });
    });

    it('prepare-reviewer-launch rejects review contexts without an explicit prompt artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-missing-prompt-path';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        const ruleContext = reviewContext.rule_context as Record<string, unknown>;
        delete ruleContext.artifact_path;
        delete ruleContext.preferred_prompt_artifact;
        fs.writeFileSync(fixture.reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('requires review context rule_context.preferred_prompt_artifact or rule_context.artifact_path')),
            prepare.errors.join('\n')
        );
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch replaces stale prepared hashes with the current routing and context hashes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch-stale';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');
        fs.mkdirSync(path.dirname(launchArtifactPath), { recursive: true });
        fs.writeFileSync(launchArtifactPath, JSON.stringify({
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: fixture.reviewerIdentity,
            review_context_sha256: 'a'.repeat(64),
            routing_event_sha256: 'b'.repeat(64),
            attestation_source: 'garda_prepare_reviewer_launch',
            launch_tool: 'stale'
        }, null, 2) + '\n', 'utf8');
        const staleArtifactSha256 = createHash('sha256').update(fs.readFileSync(launchArtifactPath)).digest('hex');
        const staleSnapshotPath = launchArtifactPath.replace(/\.json$/, `-superseded-${staleArtifactSha256}.json`);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', fixture.reviewerIdentity
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(launchArtifact.review_context_sha256, fixture.reviewContextSha256);
        assert.equal(launchArtifact.routing_event_sha256, fixture.routingEventSha256);
        assert.notEqual(launchArtifact.launch_tool, 'stale');
        assert.equal(fs.existsSync(staleSnapshotPath), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(staleSnapshotPath, 'utf8')), {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: fixture.reviewerIdentity,
            review_context_sha256: 'a'.repeat(64),
            routing_event_sha256: 'b'.repeat(64),
            attestation_source: 'garda_prepare_reviewer_launch',
            launch_tool: 'stale'
        });
        assert.equal(launchArtifact.superseded_launch_artifact.artifact_sha256, staleArtifactSha256);
        assert.equal(launchArtifact.superseded_launch_artifact.snapshot_path, staleSnapshotPath.replace(/\\/g, '/'));
        assert.ok(
            launchArtifact.superseded_launch_artifact.mismatches.includes('review_context_sha256 mismatch'),
            launchArtifact.superseded_launch_artifact.superseded_reason
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch gives a fresh reviewer attempt a distinct review output path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-718-reviewer-output-attempt';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = fixture.launchArtifactPath;

        const firstPrepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ], { cwd: repoRoot });
        assert.equal(firstPrepare.exitCode, 0, firstPrepare.errors.join('\n'));
        const firstArtifactText = fs.readFileSync(launchArtifactPath, 'utf8');
        const firstArtifactSha256 = createHash('sha256').update(firstArtifactText, 'utf8').digest('hex');
        const firstArtifact = JSON.parse(firstArtifactText);
        const firstReviewOutputPath = String(firstArtifact.review_output_path);
        const staleReviewOutputText = '# code review Output Template\n\n## Validation Notes\nfirst attempt\n';
        fs.writeFileSync(firstReviewOutputPath, staleReviewOutputText, 'utf8');

        const replacementReviewerIdentity = 'agent:test-reviewer-retry';
        const reroute = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', replacementReviewerIdentity
        ], { cwd: repoRoot });
        assert.equal(reroute.exitCode, 0, reroute.errors.join('\n'));

        const secondPrepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', replacementReviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ], { cwd: repoRoot });
        assert.equal(secondPrepare.exitCode, 0, secondPrepare.errors.join('\n'));

        const secondArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        const secondReviewOutputPath = String(secondArtifact.review_output_path);
        assert.match(path.basename(secondReviewOutputPath), /^review-output-[0-9a-f]{16}\.md$/);
        assert.notEqual(secondReviewOutputPath, firstReviewOutputPath);
        assert.equal(fs.readFileSync(firstReviewOutputPath, 'utf8'), staleReviewOutputText);
        assert.equal(fs.existsSync(secondReviewOutputPath), false);
        assert.ok(String(secondArtifact.copy_paste_reviewer_launch_prompt).includes(secondReviewOutputPath));
        assert.equal(String(secondArtifact.copy_paste_reviewer_launch_prompt).includes(firstReviewOutputPath), false);
        assert.equal(secondArtifact.superseded_launch_artifact.artifact_sha256, firstArtifactSha256);
        assert.equal(
            fs.existsSync(String(secondArtifact.superseded_launch_artifact.snapshot_path).replace(/\//g, path.sep)),
            true
        );
        assert.ok(
            secondArtifact.superseded_launch_artifact.mismatches.includes('reviewer_identity mismatch'),
            secondArtifact.superseded_launch_artifact.superseded_reason
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch leaves current prepared launch metadata unchanged', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch-current';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const runPrepare = async (): Promise<number> => {
            const previousExitCode = process.exitCode;
            const previousCwd = process.cwd();
            process.exitCode = 0;
            try {
                process.chdir(repoRoot);
                await runCliMainWithHandling([
                    'gate',
                    'prepare-reviewer-launch',
                    '--task-id', taskId,
                    '--review-type', 'code',
                    '--repo-root', repoRoot,
                    '--reviewer-execution-mode', 'delegated_subagent',
                    '--reviewer-identity', fixture.reviewerIdentity
                ]);
                return process.exitCode ?? 0;
            } finally {
                process.chdir(previousCwd);
                process.exitCode = previousExitCode;
            }
        };

        assert.equal(await runPrepare(), 0);
        const firstArtifactText = fs.readFileSync(launchArtifactPath, 'utf8');
        const firstArtifactSha256 = createHash('sha256').update(fs.readFileSync(launchArtifactPath)).digest('hex');
        const firstPreparedEvents = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED').length;

        const capturedLogs: string[] = [];
        const originalConsoleLog = console.log;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            assert.equal(await runPrepare(), 0);
        } finally {
            console.log = originalConsoleLog;
        }

        assert.equal(fs.readFileSync(launchArtifactPath, 'utf8'), firstArtifactText);
        assert.equal(createHash('sha256').update(fs.readFileSync(launchArtifactPath)).digest('hex'), firstArtifactSha256);
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED').length,
            firstPreparedEvents
        );
        assert.equal(
            fs.readdirSync(path.dirname(launchArtifactPath)).some((entry) => entry.includes('-superseded-')),
            false
        );
        assert.ok(capturedLogs.some((line) => line.includes('NextAction: existing reviewer launch metadata is current')));
        assert.ok(capturedLogs.some((line) => line.includes('LaunchInputCliFlagHelp: for launch_artifact_path mode, pass ReviewerLaunchInputArtifactSha256 to --launch-input-sha256')));
        assert.ok(capturedLogs.some((line) => line.includes('create or reserve a clean-context reviewer session first so the provider/controller assigns the agent:<id>')));
        assert.ok(capturedLogs.some((line) => line.includes('keep that clean-context session in standby')));
        assert.ok(capturedLogs.some((line) => line.includes('resume it and send the exact ReviewerLaunchInputArtifactPath')));
        assert.ok(capturedLogs.some((line) => line.includes('standby completion before launch input delivery is expected provider handshake noise, not review evidence')));
        assert.ok(capturedLogs.some((line) => line.includes('Launch a real subagent using built-in tools')));
        assert.ok(capturedLogs.some((line) => line.includes('if for some reason that is impossible right now, you must stop and report this to the user')));
        assert.ok(capturedLogs.some((line) => line.includes('this is expected behavior in this repository')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch replaces legacy prepared metadata that lacks copy-paste handoff fields', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch-legacy-handoff';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const runPrepare = async (): Promise<number> => {
            const previousExitCode = process.exitCode;
            const previousCwd = process.cwd();
            process.exitCode = 0;
            try {
                process.chdir(repoRoot);
                await runCliMainWithHandling([
                    'gate',
                    'prepare-reviewer-launch',
                    '--task-id', taskId,
                    '--review-type', 'code',
                    '--repo-root', repoRoot,
                    '--reviewer-execution-mode', 'delegated_subagent',
                    '--reviewer-identity', fixture.reviewerIdentity
                ]);
                return process.exitCode ?? 0;
            } finally {
                process.chdir(previousCwd);
                process.exitCode = previousExitCode;
            }
        };

        assert.equal(await runPrepare(), 0);
        const legacyArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        delete legacyArtifact.review_output_path;
        delete legacyArtifact.copy_paste_reviewer_launch_prompt;
        fs.writeFileSync(launchArtifactPath, `${JSON.stringify(legacyArtifact, null, 2)}\n`, 'utf8');

        assert.equal(await runPrepare(), 0);
        const refreshedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.match(path.basename(String(refreshedArtifact.review_output_path)), /^review-output-[0-9a-f]{16}\.md$/);
        assert.notEqual(
            refreshedArtifact.review_output_path,
            path.join(path.dirname(launchArtifactPath), 'review-output.md').replace(/\\/g, '/')
        );
        assert.equal(typeof refreshedArtifact.review_output_attempt_sha256, 'string');
        assert.match(refreshedArtifact.review_output_attempt_sha256, /^[0-9a-f]{64}$/);
        assert.ok(String(refreshedArtifact.copy_paste_reviewer_launch_prompt).includes('First open and read RolePromptPath:'));
        assert.ok(String(refreshedArtifact.copy_paste_reviewer_launch_prompt).includes('Then open and read PromptTemplatePath:'));
        assert.ok(String(refreshedArtifact.copy_paste_reviewer_launch_prompt).includes('Required sections: Validation Notes, Findings by Severity, Deferred Findings, Residual Risks, Verdict.'));
        assert.equal(refreshedArtifact.superseded_launch_artifact.mismatches.includes('review_output_path mismatch'), true);
        assert.equal(refreshedArtifact.superseded_launch_artifact.mismatches.includes('copy_paste_reviewer_launch_prompt mismatch'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
