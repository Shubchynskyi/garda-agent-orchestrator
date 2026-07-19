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
    path,
    prepareCurrentReviewPhase,
    recordReviewerDelegationStartedForTest,
    readTaskTimelineEvents,
    runCliMainWithHandling,
    runCliWithCapturedOutput,
    runGit,
    seedInitAnswers,
    seedRoutedReviewerLaunchFixture,
    seedTaskQueue,
    writePreflight
} from './gates-command-review-launch-fixtures';
import { isCompletedReviewerLaunchAttemptConsumed } from '../../../../../../src/cli/commands/gate-review-handlers/launch/reviewer-handoff-support';
import { buildReviewerTerminalContractLines } from '../../../../../../src/gates/review/reviewer-execution-contract';

const FORBIDDEN_DEFAULT_REVIEWER_RESERVATION_GUIDANCE = [
    'STANDBY',
    'standby',
    'idle wait',
    'idle reviewer',
    'resumable session',
    'resumable reviewer',
    'reviewer reservation',
    'pre-launch reviewer reservation',
    'reserve a reviewer',
    'keep the reviewer alive',
    'wait for further instructions'
];

function assertNoDefaultReviewerReservationGuidance(text: string): void {
    for (const forbiddenText of FORBIDDEN_DEFAULT_REVIEWER_RESERVATION_GUIDANCE) {
        assert.equal(
            text.includes(forbiddenText),
            false,
            `default reviewer launch guidance must not include ${forbiddenText}`
        );
    }
}

describe('completed reviewer launch attempt lifecycle', () => {
    it('treats a completed attempt as replaceable only after its matching review result is recorded', () => {
        const attemptId = '2d594f42-616c-4cf4-bcc6-acad476f63c1';
        const artifact = {
            reviewer_launch_attempt_id: attemptId,
            review_type: 'code',
            reviewer_identity: 'agent:completed-reviewer',
            review_context_sha256: 'a'.repeat(64)
        };
        const completedEvent = {
            event_type: 'REVIEWER_LAUNCH_COMPLETED',
            sequence: 3,
            details: {
                reviewer_launch_attempt_id: attemptId,
                review_type: 'code',
                reviewer_identity: 'agent:completed-reviewer',
                review_context_sha256: 'a'.repeat(64)
            },
            integrity: null
        };
        const recordedEvent = {
            event_type: 'REVIEW_RECORDED',
            sequence: 5,
            details: {
                review_type: 'code',
                reviewer_identity: 'agent:completed-reviewer',
                review_context_sha256: 'a'.repeat(64)
            },
            integrity: null
        };

        assert.equal(isCompletedReviewerLaunchAttemptConsumed([completedEvent], artifact), false);
        assert.equal(isCompletedReviewerLaunchAttemptConsumed([completedEvent, recordedEvent], artifact), true);
    });
});

function enableAfterCompileFullSuiteEvidence(repoRoot: string, taskId: string, preflightPath: string): void {
    fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), JSON.stringify({
        full_suite_validation: {
            enabled: true,
            command: 'npm test',
            placement: 'after_compile_before_reviews'
        },
        review_execution_policy: {
            mode: 'parallel_all'
        }
    }, null, 2) + '\n', 'utf8');
    const latestCompile = [...readTaskTimelineEvents(repoRoot, taskId)]
        .reverse()
        .find((event) => event.event_type === 'COMPILE_GATE_PASSED');
    const cycleBinding = {
        task_id: taskId,
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_sha256: fileSha256ForTest(preflightPath),
        compile_gate_timestamp: String(latestCompile?.timestamp_utc || '')
    };
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-full-suite-validation.json`), JSON.stringify({
        task_id: taskId,
        status: 'PASSED',
        enabled: true,
        command: 'npm test',
        placement: 'after_compile_before_reviews',
        exit_code: 0,
        cycle_binding: cycleBinding,
        output_artifact_path: path.join(reviewsRoot, `${taskId}-full-suite-output.log`).replace(/\\/g, '/')
    }, null, 2) + '\n', 'utf8');
}

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
        assert.match(
            launchArtifact.reviewer_launch_attempt_id,
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );
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
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Fill OutputTemplatePath exactly, preserving the required JSON object shape:'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(fixture.outputTemplatePath.replace(/\\/g, '/')));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(`OutputTemplateSha256: ${outputTemplateSha256}`));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Required JSON fields: schema_version, task_id, review_type, review_context_sha256, tree_state_sha256, validation_notes, coverage_ledger, findings, residual_risks, reviewer_notes.'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes(`Required JSON binding values: task_id=${taskId}; review_type=code; review_context_sha256=${fixture.reviewContextSha256}; tree_state_sha256=${fixture.reviewTreeStateSha256}.`));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Active finding object fields: id, title, description, evidence[{location, observation}], coverage_obligation_ids.'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Return exactly one JSON object'));
        assert.ok(String(launchArtifact.copy_paste_reviewer_launch_prompt).includes('Do not include review verdict, PASS/FAIL, status'));
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
        const launchInputArtifactText = fs.readFileSync(launchInputArtifactPath, 'utf8');
        assert.ok(
            launchInputArtifactText.startsWith('{\n  "reviewer_handoff_contract": "You are the delegated code reviewer for this Garda task."'),
            launchInputArtifactText
        );
        const launchInputArtifact = JSON.parse(launchInputArtifactText);
        assert.equal(launchInputArtifact.artifact_type, 'delegated_reviewer_handoff');
        assert.equal(launchInputArtifact.handoff_role, 'delegated_reviewer');
        assert.equal(launchInputArtifact.task_id, taskId);
        assert.equal(launchInputArtifact.review_type, 'code');
        assert.equal(launchInputArtifact.reviewer_launch_attempt_id, launchArtifact.reviewer_launch_attempt_id);
        assert.equal(launchInputArtifact.copy_paste_reviewer_launch_prompt, launchArtifact.copy_paste_reviewer_launch_prompt);
        assert.equal(launchInputArtifact.copy_paste_reviewer_launch_prompt_sha256, copyPastePromptSha256);
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes(`PromptTemplatePath: ${fixture.promptTemplatePath.replace(/\\/g, '/')}`));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes('Fill OutputTemplatePath exactly'));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes(fixture.outputTemplatePath.replace(/\\/g, '/')));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes('Required JSON fields: schema_version, task_id, review_type, review_context_sha256, tree_state_sha256, validation_notes, coverage_ledger, findings, residual_risks, reviewer_notes.'));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes(`Required JSON binding values: task_id=${taskId}; review_type=code; review_context_sha256=${fixture.reviewContextSha256}; tree_state_sha256=${fixture.reviewTreeStateSha256}.`));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes('Active finding object fields: id, title, description, evidence[{location, observation}], coverage_obligation_ids.'));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes('Finding a Critical, High, Medium, or Low defect does not end the review'));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes('report every distinct evidence-supported finding in the same result'));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes('Deduplicate findings that share one root cause'));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes('re-sweep the complete current assigned scope'));
        assert.equal(launchInputArtifact.prompt_template_sha256, launchArtifact.prompt_template_sha256);
        assert.equal(launchInputArtifact.output_template_sha256, launchArtifact.output_template_sha256);
        assert.equal(launchInputArtifact.review_output_path, reviewOutputPath.replace(/\\/g, '/'));
        assert.equal(launchInputArtifact.next_action, undefined);
        assert.equal(launchInputArtifact.after_launch_required_updates, undefined);
        assert.equal(launchInputArtifact.record_reviewer_delegation_started_command, undefined);
        assert.equal(launchInputArtifact.complete_reviewer_launch_command, undefined);
        assert.equal(
            launchInputArtifactText.includes('Launch a fresh delegated reviewer'),
            false,
            'reviewer-facing launch input must not tell a clean-context subagent to launch another reviewer'
        );
        assert.ok(
            Array.isArray(launchInputArtifact.reviewer_only_instructions)
                && launchInputArtifact.reviewer_only_instructions.includes('Do not launch another reviewer or subagent.')
        );
        assert.ok(
            Array.isArray(launchInputArtifact.reviewer_only_instructions)
                && launchInputArtifact.reviewer_only_instructions.includes('You are not the main orchestrating agent for TASK.md.')
        );
        assert.ok(
            Array.isArray(launchInputArtifact.reviewer_only_instructions)
                && launchInputArtifact.reviewer_only_instructions.some((instruction: unknown) => String(instruction).includes('Do not run Garda workflow/navigation/validation gates such as next-step'))
        );
        assert.ok(
            Array.isArray(launchInputArtifact.reviewer_only_instructions)
                && launchInputArtifact.reviewer_only_instructions.some((instruction: unknown) => String(instruction).includes('Do not modify reviewer launch/control artifacts'))
        );
        assert.deepEqual(
            (launchInputArtifact.reviewer_only_instructions as string[]).slice(-buildReviewerTerminalContractLines().length),
            buildReviewerTerminalContractLines().map((line) => line.replace(/^- /u, ''))
        );
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes('Reviewer-only boundary: you are not the main orchestrating agent for TASK.md.'));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes('Do not run Garda workflow/navigation/validation gates such as next-step'));
        assert.ok(launchInputArtifact.copy_paste_reviewer_launch_prompt.includes('Only read the artifacts named in this handoff and write the completed review JSON to the single ReviewOutputPath'));
        assert.deepEqual(launchArtifact.preserve_prepared_fields, [
            'reviewer_launch_attempt_id',
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
        assert.ok(String(launchArtifact.record_invocation_command).includes(`--reviewer-identity '${fixture.reviewerIdentity}'`));
        const commandReviewContextPath = path.relative(repoRoot, fixture.reviewContextPath).replace(/\\/g, '/');
        const commandLaunchArtifactPath = path.relative(repoRoot, launchArtifactPath).replace(/\\/g, '/');
        const commandLaunchInputArtifactPath = path.relative(repoRoot, launchInputArtifactPath).replace(/\\/g, '/');
        const recordDelegationCommand = String(launchArtifact.record_reviewer_delegation_started_command);
        assert.ok(recordDelegationCommand.includes('gate record-reviewer-delegation-started'));
        assert.ok(recordDelegationCommand.includes(`--review-context-path '${commandReviewContextPath}'`));
        assert.ok(recordDelegationCommand.includes("--reviewer-execution-mode 'delegated_subagent'"));
        assert.ok(recordDelegationCommand.includes("--reviewer-identity '<agent:resolved-provider-reviewer-id-from-delegated-agent>'"));
        assert.ok(recordDelegationCommand.includes(`--reviewer-launch-artifact-path '${commandLaunchArtifactPath}'`));
        assert.ok(recordDelegationCommand.includes("--provider-invocation-id '<provider-owned invocation id from delegated reviewer launch result>'"));
        assert.ok(recordDelegationCommand.includes("--attestation-source '<provider-owned attestation source from delegated reviewer launch result>'"));
        assert.ok(recordDelegationCommand.includes("--launch-input-mode 'launch_artifact_path'"));
        assert.ok(recordDelegationCommand.includes(`--launch-input-artifact-path '${commandLaunchInputArtifactPath}'`));
        assert.ok(recordDelegationCommand.includes(`--launch-input-sha256 '${pinnedInputArtifactSha256}'`));
        assert.ok(recordDelegationCommand.includes('--fork-context false'));
        const completeLaunchCommand = String(launchArtifact.complete_reviewer_launch_command);
        assert.ok(completeLaunchCommand.includes('gate complete-reviewer-launch'));
        assert.ok(completeLaunchCommand.includes(`--review-context-path '${commandReviewContextPath}'`));
        assert.ok(completeLaunchCommand.includes("--reviewer-execution-mode 'delegated_subagent'"));
        assert.ok(completeLaunchCommand.includes("--reviewer-identity '<agent:resolved-provider-reviewer-id-from-delegated-agent>'"));
        assert.ok(completeLaunchCommand.includes(`--reviewer-launch-artifact-path '${commandLaunchArtifactPath}'`));
        assert.ok(completeLaunchCommand.includes("--provider-invocation-id '<provider-owned invocation id from delegated reviewer launch result>'"));
        assert.ok(completeLaunchCommand.includes("--attestation-source '<provider-owned attestation source from delegated reviewer launch result>'"));
        assert.ok(completeLaunchCommand.includes("--launch-input-mode 'launch_artifact_path'"));
        assert.ok(completeLaunchCommand.includes(`--launch-input-artifact-path '${commandLaunchInputArtifactPath}'`));
        assert.ok(completeLaunchCommand.includes(`--launch-input-sha256 '${pinnedInputArtifactSha256}'`));
        assert.ok(completeLaunchCommand.includes('--fork-context false'));
        assert.ok(completeLaunchCommand.includes('--record-invocation'));
        assert.ok(String(launchArtifact.next_action).includes('Launch a real subagent using built-in tools'));
        assert.ok(String(launchArtifact.next_action).includes('if for some reason that is impossible right now, you must stop and report this to the user'));
        assert.ok(String(launchArtifact.next_action).includes('this is expected behavior in this repository'));
        assert.ok(String(launchArtifact.next_action).includes('Launch a fresh delegated reviewer once'));
        assert.ok(String(launchArtifact.next_action).includes('launch one clean-context delegated reviewer with the exact CopyPasteReviewerLaunchPrompt or reviewer-facing ReviewerLaunchInputArtifactPath'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const launchPreparedEvent = events.find((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED');
        const launchPreparedIntegrity = launchPreparedEvent?.integrity as { event_sha256?: string } | undefined;
        const launchPreparedDetails = launchPreparedEvent?.details as Record<string, unknown> | undefined;
        assert.equal(launchPreparedIntegrity?.event_sha256, launchArtifact.prepared_launch_event_sha256);
        assert.equal(launchPreparedDetails?.launch_prepared_at_utc, launchArtifact.launch_prepared_at_utc);
        assert.equal(launchPreparedDetails?.reviewer_launch_input_artifact_path, launchInputArtifactPath.replace(/\\/g, '/'));
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        const capturedOutput = capturedLogs.join('\n');
        assert.ok(capturedLogs[0]?.startsWith('Next action:\n'));
        assert.ok(capturedOutput.includes('  Gate: prepare-reviewer-launch'));
        assert.ok(capturedOutput.includes('  Do: Launch one clean-context delegated reviewer'));
        assert.ok(capturedOutput.includes('  Command: none'));
        assert.ok(capturedOutput.includes('  CommandReference: launch the reviewer with reviewer-facing ReviewerLaunchInputArtifactPath'));
        assert.equal(capturedLogs.some((line) => line.startsWith('NextAction:')), false);
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
        assert.ok(capturedLogs.some((line) => line.includes('OneShotLaunchState: default_handoff_ready_not_review_evidence')));
        assert.ok(capturedLogs.some((line) => line.includes('ReviewerLaunchInputArtifactRole: reviewer_facing_handoff_not_launcher_control_metadata')));
        assert.ok(capturedLogs.some((line) => line.includes('OneShotLaunchInstruction: After `prepare-reviewer-launch`, launch one clean-context delegated reviewer')));
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
        assert.ok(capturedLogs.some((line) => line.includes('PreservePreparedFields: reviewer_launch_attempt_id, review_context_sha256')));
        assert.ok(capturedLogs.some((line) => line.includes('RecordReviewerDelegationStartedCommand: node garda-agent-orchestrator/bin/garda.js gate record-reviewer-delegation-started')));
        assert.ok(capturedLogs.some((line) => line.includes(`--launch-input-artifact-path '${commandLaunchInputArtifactPath}'`)));
        assert.ok(capturedLogs.some((line) => line.includes(`--launch-input-sha256 '${pinnedInputArtifactSha256}'`)));
        assert.ok(capturedLogs.some((line) => line.includes('--fork-context false')));
        assert.ok(capturedLogs.some((line) => line.includes('CompleteReviewerLaunchCommand: node garda-agent-orchestrator/bin/garda.js gate complete-reviewer-launch')));
        assert.ok(capturedLogs.some((line) => line.includes('--record-invocation')));
        assert.ok(capturedLogs.some((line) => line.includes('RecordInvocationCommand: node garda-agent-orchestrator/bin/garda.js gate record-review-invocation')));
        assert.ok(capturedLogs.some((line) => line.includes('CopyPasteReviewerLaunchPrompt:')));
        assert.ok(capturedLogs.some((line) => line.includes('First open and read RolePromptPath:')));
        assert.ok(capturedLogs.some((line) => line.includes(`RolePromptSha256: ${rolePromptSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('Then open and read PromptTemplatePath:')));
        assert.ok(capturedLogs.some((line) => line.includes(`PromptTemplateSha256: ${promptTemplateSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('Then open and read ReviewerPromptPath:')));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewerPromptSha256: ${fixture.reviewerPromptSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('Use EvidenceManifestPath to locate the review context, scoped diff, and supporting evidence:')));
        assert.ok(capturedLogs.some((line) => line.includes(`EvidenceManifestSha256: ${evidenceManifestSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('Fill OutputTemplatePath exactly, preserving the required JSON object shape:')));
        assert.ok(capturedLogs.some((line) => line.includes(`OutputTemplateSha256: ${outputTemplateSha256}`)));
        assert.ok(capturedLogs.some((line) => line.includes('Required JSON fields: schema_version, task_id, review_type, review_context_sha256, tree_state_sha256, validation_notes, coverage_ledger, findings, residual_risks, reviewer_notes.')));
        assert.ok(capturedLogs.some((line) => line.includes('Do not include review verdict, PASS/FAIL, status')));
        assert.ok(capturedLogs.some((line) => line.includes('Write the final review report to ReviewOutputPath when file writing is available')));
        assert.ok(capturedLogs.some((line) => line.includes('NextStep: After `prepare-reviewer-launch`, launch one clean-context delegated reviewer')));
        assert.ok(capturedLogs.some((line) => line.includes('Launch a real subagent using built-in tools')));
        assert.ok(capturedLogs.some((line) => line.includes('if for some reason that is impossible right now, you must stop and report this to the user')));
        assert.ok(capturedLogs.some((line) => line.includes('this is expected behavior in this repository')));
        assertNoDefaultReviewerReservationGuidance(capturedLogs.join('\n'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch single-quotes shell-substitution metacharacters in launch commands', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch-shell-safe';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const dangerousSegment = 'reviewer-$(whoami)`x';
        const launchArtifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            dangerousSegment,
            'reviewer-launch.json'
        );
        const launchInputArtifactPath = path.join(path.dirname(launchArtifactPath), 'reviewer-launch-input.json');

        const result = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ], { cwd: repoRoot });

        assert.equal(result.exitCode, 0, result.errors.join('\n') || result.logs.join('\n'));
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        const quoteLaunchCommandValueForTest = (value: string): string => `'${value.replace(/\\/g, '/')}'`;
        const commandLaunchArtifactPath = quoteLaunchCommandValueForTest(path.relative(repoRoot, launchArtifactPath));
        const commandLaunchInputArtifactPath = quoteLaunchCommandValueForTest(path.relative(repoRoot, launchInputArtifactPath));
        const recordDelegationCommand = String(launchArtifact.record_reviewer_delegation_started_command);
        const completeLaunchCommand = String(launchArtifact.complete_reviewer_launch_command);

        assert.ok(recordDelegationCommand.includes(`--reviewer-launch-artifact-path ${commandLaunchArtifactPath}`));
        assert.ok(recordDelegationCommand.includes(`--launch-input-artifact-path ${commandLaunchInputArtifactPath}`));
        assert.ok(completeLaunchCommand.includes(`--reviewer-launch-artifact-path ${commandLaunchArtifactPath}`));
        assert.ok(completeLaunchCommand.includes(`--launch-input-artifact-path ${commandLaunchInputArtifactPath}`));
        assert.ok(!recordDelegationCommand.includes('--reviewer-launch-artifact-path "'));
        assert.ok(!recordDelegationCommand.includes('--launch-input-artifact-path "'));
        assert.ok(!completeLaunchCommand.includes('--reviewer-launch-artifact-path "'));
        assert.ok(!completeLaunchCommand.includes('--launch-input-artifact-path "'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch uses source-checkout CLI prefix for source workspaces', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch-source-prefix';
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2) + '\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });

        const result = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', fixture.launchArtifactPath
        ], { cwd: repoRoot });

        assert.equal(result.exitCode, 0, result.errors.join('\n') || result.logs.join('\n'));
        const launchArtifact = JSON.parse(fs.readFileSync(fixture.launchArtifactPath, 'utf8'));
        assert.match(String(launchArtifact.record_reviewer_delegation_started_command), /^node bin\/garda\.js gate record-reviewer-delegation-started /);
        assert.match(String(launchArtifact.complete_reviewer_launch_command), /^node bin\/garda\.js gate complete-reviewer-launch /);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch rejects apostrophes instead of emitting shell-specific copy-paste commands', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-266-prepare-launch-apostrophe-path';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        const launchArtifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            'code',
            "reviewer'quote",
            'reviewer-launch.json'
        );

        const result = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.match(result.errors.join('\n') || result.logs.join('\n'), /Cannot emit a shell-agnostic copy-paste reviewer launch command/);
        if (fs.existsSync(launchArtifactPath)) {
            const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
            assert.equal(launchArtifact.record_reviewer_delegation_started_command, undefined);
            assert.equal(launchArtifact.complete_reviewer_launch_command, undefined);
        }

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

    it('prepare-reviewer-launch rejects review contexts missing required full-suite binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-launch-full-suite-binding';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        enableAfterCompileFullSuiteEvidence(repoRoot, taskId, fixture.preflightPath);

        const prepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json')
        ], { cwd: repoRoot });

        assert.notEqual(prepare.exitCode, 0);
        assert.ok(
            prepare.errors.some((line) => line.includes('review context full-suite validation binding is missing')),
            prepare.errors.join('\n')
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);
    });

    it('record-review-routing rejects legacy schema-1 review contexts missing required full-suite binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-launch-legacy-full-suite-binding';
        const fixture = await seedRoutedReviewerLaunchFixture({ repoRoot, taskId });
        enableAfterCompileFullSuiteEvidence(repoRoot, taskId, fixture.preflightPath);
        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        reviewContext.schema_version = 1;
        delete reviewContext.full_suite_validation;
        fs.writeFileSync(reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');
        const routedEventCountBefore = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length;
        const routing = await runCliWithCapturedOutput([
            'gate',
            'record-review-routing',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(routing.exitCode, 0);
        assert.ok(
            routing.errors.some((line) => line.includes('review context full-suite validation binding is missing')),
            routing.errors.join('\n')
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length,
            routedEventCountBefore
        );
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED'), false);
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
        const firstArtifact = JSON.parse(firstArtifactText);
        const firstLaunchAttemptId = String(firstArtifact.reviewer_launch_attempt_id);
        const firstReviewOutputPath = String(firstArtifact.review_output_path);
        const staleReviewOutputText = '# code review Output Template\n\n## Validation Notes\nfirst attempt\n';
        fs.writeFileSync(firstReviewOutputPath, staleReviewOutputText, 'utf8');

        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-first-attempt'
        });
        const failedLaunch = await runCliWithCapturedOutput([
            'gate',
            'record-reviewer-launch-failed',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            '--provider-invocation-id', 'test-invocation-first-attempt',
            '--failure-reason', 'Provider terminated the delegated reviewer before output was available.'
        ], { cwd: repoRoot });
        assert.equal(failedLaunch.exitCode, 0, failedLaunch.errors.join('\n'));
        const failedArtifactSha256 = fileSha256ForTest(launchArtifactPath);

        const secondPrepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ], { cwd: repoRoot });
        assert.equal(secondPrepare.exitCode, 0, secondPrepare.errors.join('\n'));

        const secondArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.notEqual(secondArtifact.reviewer_launch_attempt_id, firstLaunchAttemptId);
        const secondReviewOutputPath = String(secondArtifact.review_output_path);
        assert.match(path.basename(secondReviewOutputPath), /^review-output-[0-9a-f]{16}\.md$/);
        assert.notEqual(secondReviewOutputPath, firstReviewOutputPath);
        assert.equal(fs.readFileSync(firstReviewOutputPath, 'utf8'), staleReviewOutputText);
        assert.equal(fs.existsSync(secondReviewOutputPath), false);
        assert.ok(String(secondArtifact.copy_paste_reviewer_launch_prompt).includes(secondReviewOutputPath));
        assert.equal(String(secondArtifact.copy_paste_reviewer_launch_prompt).includes(firstReviewOutputPath), false);
        assert.equal(secondArtifact.superseded_launch_artifact.artifact_sha256, failedArtifactSha256);
        assert.equal(
            fs.existsSync(String(secondArtifact.superseded_launch_artifact.snapshot_path).replace(/\//g, path.sep)),
            true
        );
        assert.ok(
            secondArtifact.superseded_launch_artifact.mismatches.includes('attestation_state mismatch'),
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
        const firstArtifact = JSON.parse(firstArtifactText) as Record<string, unknown>;
        assert.match(String(firstArtifact.reviewer_launch_attempt_id), /^[0-9a-f-]{36}$/);
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
        const capturedOutput = capturedLogs.join('\n');
        assert.ok(capturedLogs[0]?.startsWith('Next action:\n'));
        assert.ok(capturedOutput.includes('  Gate: prepare-reviewer-launch'));
        assert.ok(capturedOutput.includes('Current reviewer launch metadata is already prepared'));
        assert.equal(capturedLogs.some((line) => line.startsWith('NextAction:')), false);
        assert.ok(capturedLogs.some((line) => line.includes('NextStep: existing reviewer launch metadata is current')));
        assert.ok(capturedLogs.some((line) => line.includes('LaunchInputCliFlagHelp: for launch_artifact_path mode, pass ReviewerLaunchInputArtifactSha256 to --launch-input-sha256')));
        assert.ok(capturedLogs.some((line) => line.includes('OneShotLaunchState: default_handoff_ready_not_review_evidence')));
        assert.ok(capturedLogs.some((line) => line.includes('RecordReviewerDelegationStartedCommand: node garda-agent-orchestrator/bin/garda.js gate record-reviewer-delegation-started')));
        assert.ok(capturedLogs.some((line) => line.includes('CompleteReviewerLaunchCommand: node garda-agent-orchestrator/bin/garda.js gate complete-reviewer-launch')));
        assert.ok(capturedLogs.some((line) => line.includes('--record-invocation')));
        assert.ok(capturedLogs.some((line) => line.includes('Launch a real subagent using built-in tools')));
        assert.ok(capturedLogs.some((line) => line.includes('if for some reason that is impossible right now, you must stop and report this to the user')));
        assert.ok(capturedLogs.some((line) => line.includes('this is expected behavior in this repository')));
        assertNoDefaultReviewerReservationGuidance(capturedLogs.join('\n'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch cannot replace an immutable delegation-started attempt', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-979-22-prepare-inflight';
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
        await recordReviewerDelegationStartedForTest({
            repoRoot,
            taskId,
            reviewerIdentity: fixture.reviewerIdentity,
            launchArtifactPath,
            providerInvocationId: 'test-invocation-inflight'
        });
        const startedArtifactText = fs.readFileSync(launchArtifactPath, 'utf8');
        const preparedEventCount = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED').length;

        const repeatedPrepare = await runCliWithCapturedOutput([
            'gate',
            'prepare-reviewer-launch',
            '--task-id', taskId,
            '--review-type', 'code',
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath
        ], { cwd: repoRoot });

        assert.notEqual(repeatedPrepare.exitCode, 0);
        assert.ok(
            repeatedPrepare.errors.some((line) => line.includes('immutable reviewer launch attempt is already delegation_started')),
            repeatedPrepare.errors.join('\n')
        );
        assert.equal(fs.readFileSync(launchArtifactPath, 'utf8'), startedArtifactText);
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEWER_LAUNCH_PREPARED').length,
            preparedEventCount
        );
        assert.equal(
            fs.readdirSync(path.dirname(launchArtifactPath)).some((entry) => entry.includes('-superseded-')),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-reviewer-launch assigns planned reviewer identity when --reviewer-identity is omitted', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-776-F1-planned-identity';
        const fixture = await seedRoutedReviewerLaunchFixture({
            repoRoot,
            taskId,
            reviewerIdentity: 'agent:pending:T-776-F1-planned-identity-code'
        });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code', 'reviewer-launch.json');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(path.join(repoRoot, 'src'));
            await runCliMainWithHandling([
                'gate',
                'prepare-reviewer-launch',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8'));
        assert.equal(launchArtifact.reviewer_identity, 'agent:pending:T-776-F1-planned-identity-code');
        assert.equal(launchArtifact.planned_reviewer_identity, 'agent:pending:T-776-F1-planned-identity-code');
        assert.equal(fixture.reviewerIdentity, 'agent:pending:T-776-F1-planned-identity-code');

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
        delete legacyArtifact.reviewer_launch_attempt_id;
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
        assert.ok(String(refreshedArtifact.copy_paste_reviewer_launch_prompt).includes('Required JSON fields: schema_version, task_id, review_type, review_context_sha256, tree_state_sha256, validation_notes, coverage_ledger, findings, residual_risks, reviewer_notes.'));
        assert.equal(refreshedArtifact.superseded_launch_artifact.mismatches.includes('review_output_path mismatch'), true);
        assert.equal(refreshedArtifact.superseded_launch_artifact.mismatches.includes('copy_paste_reviewer_launch_prompt mismatch'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
