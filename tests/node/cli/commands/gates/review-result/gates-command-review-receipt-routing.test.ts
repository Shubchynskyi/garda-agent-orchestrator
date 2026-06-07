import {
    describe,
    it,
    assert,
    fs,
    os,
    path,
    createHash,
    runCompileGateCommand,
    runDocImpactGateCommand,
    runLogTaskEventCommand,
    runRequiredReviewsCheckCommand,
    runCliMainWithHandling,
    runCompletionGate,
    buildReviewContext,
    getWorkspaceSnapshot,
    buildReviewTreeState,
    appendTaskEvent,
    createTempRepo,
    writeReviewCapabilitiesConfig,
    seedTaskQueue,
    seedInitAnswers,
    getReviewsRoot,
    getOrchestratorRoot,
    runEnterTaskMode,
    createReviewerRoutingFixture,
    writePreflight,
    writeCompilePassEvidence,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runHandshakeForTask,
    runShellSmokeForTask,
    prepareCurrentReviewPhase,
    runGit,
    initializeGitRepo,
    readTaskTimelineEvents,
    findLastTimelineEventIndex,
    runCliWithCapturedOutput,
    applyReviewerRoutingMetadata,
    fileSha256,
    manualReviewContextTaskScopeFixture,
    manualReviewContextBindingFixture,
    reviewContextScopedDiffFixture,
    recordReviewRoutingViaCli,
    attestReviewerInvocationForTest,
    seedPromptBoundReviewFixture,
    seedRoutedReviewerLaunchFixture,
    prepareReviewerLaunchForTest,
    completeReviewerLaunchArtifactForTest
} from './gates-command-review-result-fixtures';

describe('gates command review receipt - routing', () => {

    it('record-review-receipt rejects stale reviewer prompt artifacts before writing receipts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-stale-prompt-receipt';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });

        const artifactPath = path.join(fixture.reviewsRoot, `${taskId}-code.md`);
        fs.writeFileSync(artifactPath, [
            '# Code Review',
            '',
            'Validated the reviewer prompt binding path and current invocation telemetry before writing the receipt artifact.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        fs.writeFileSync(fixture.reviewerPromptPath, 'stale reviewer prompt payload before receipt recording\n', 'utf8');
        const receipt = await runCliWithCapturedOutput([
            'gate',
            'record-review-receipt',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(receipt.exitCode, 0);
        assert.ok(
            receipt.errors.some((line) => line.includes('record-review-receipt cannot continue because reviewer prompt artifact is stale')),
            receipt.errors.join('\n')
        );
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects delegated mode without pre-recorded routing evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y',
            '## Summary',
            'Verified `src/app.ts` delegated routing wiring with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects stale routing telemetry replayed from a prior cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-stale-routing-replay';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const priorPreflightPath = writePreflight(repoRoot, taskId, {
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
            }
        }, `${taskId}-prior-preflight.json`);
        prepareCurrentReviewPhase(repoRoot, taskId, priorPreflightPath);

        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Historical review phase started.', {
            review_type: 'code'
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Historical code review routed.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Current review phase started.', {
            review_type: 'code'
        });

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-stale-routing-replay',
            '## Summary',
            'Verified stale routing replay handling with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: 'agent:test-reviewer',
            fallbackReason: null
        });

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const matchingRoutingIndices = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => (
                event.event_type === 'REVIEWER_DELEGATION_ROUTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
                && String((event.details as Record<string, unknown> | undefined)?.reviewer_session_id || '') === 'agent:test-reviewer'
            ))
            .map(({ index }) => index);
        assert.ok(latestCodeReviewPhaseIndex >= 0);
        assert.ok(matchingRoutingIndices.some((index) => index < latestCodeReviewPhaseIndex));
        assert.equal(matchingRoutingIndices.some((index) => index > latestCodeReviewPhaseIndex), false);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt accepts earlier matching same-cycle routing telemetry when reviewer identity still matches the review context', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-superseded-routing';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Earlier same-cycle code review routed.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Later same-cycle code review rerouted to a different reviewer.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:new-reviewer',
            delegation_used: true
        });

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-superseded-routing',
            '## Summary',
            'Verified that superseded same-cycle routing telemetry cannot be replayed by tampering the review-context back to an older reviewer identity.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: 'agent:test-reviewer',
            fallbackReason: null
        });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath,
            reviewerIdentity: 'agent:test-reviewer'
        });
        const expectedReviewOutputSourceMtimeUtc = fs.statSync(artifactPath).mtime.toISOString();

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(receiptPath), true);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:test-reviewer');
        assert.equal(receipt.reviewer_fallback_reason, null);
        assert.equal(receipt.review_output_path, artifactPath.replace(/\\/g, '/'));
        assert.equal(receipt.review_output_sha256, fileSha256(artifactPath));
        assert.equal(receipt.review_output_source_mtime_utc, expectedReviewOutputSourceMtimeUtc);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.expected_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.fallback_allowed, false);
        assert.equal(reviewContext.reviewer_routing.fallback_reason_required, false);
        assert.equal(reviewContext.reviewer_routing.fallback_reason, null);
        const recordedEvents = readTaskTimelineEvents(repoRoot, taskId).filter((event) => event.event_type === 'REVIEW_RECORDED');
        assert.equal(recordedEvents.length, 1);
        assert.equal((recordedEvents[0]?.details as Record<string, unknown> | undefined)?.reviewer_fallback_reason ?? null, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt accepts delegated_subagent for Qwen after fallback removal', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-receipt-single-agent';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Qwen');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-receipt-single-agent',
            '## Summary',
            'Verified delegated receipt acceptance for Qwen after fallback removal, with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Qwen')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: 'agent:test-reviewer',
            fallbackReason: null
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated routing recorded for Qwen review fixture', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath,
            reviewerIdentity: 'agent:test-reviewer'
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            console.log = (...args: unknown[]) => {
                capturedLogs.push(args.map(String).join(' '));
                originalLog(...args);
            };
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), true);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), true);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewerCleanup: After the review receipt is persisted')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt accepts delegated_subagent when direct Codex runtime remains delegation-required', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-receipt-policy-tamper';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-receipt-policy-tamper',
            '',
            'Validated `src/cli/commands/gate-review-handlers.ts` and the receipt-side routing enforcement path with enough implementation detail to prove that direct Codex sessions now keep delegated reviewer provenance instead of downgrading to same-agent fallback.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: `agent:${taskId}-reviewer`,
            fallbackReason: null
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'tampered fallback routed for receipt fixture', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${taskId}-reviewer`,
            reviewer_fallback_reason: null,
            delegation_used: true
        });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath,
            reviewerIdentity: `agent:${taskId}-reviewer`
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', `agent:${taskId}-reviewer`
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const receipt = JSON.parse(fs.readFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), 'utf8'));
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, `agent:${taskId}-reviewer`);
        assert.equal(receipt.reviewer_fallback_reason, null);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('records delegated routing and receipt through the public CLI path for bridge-backed providers', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904z',
            '## Summary',
            'Verified delegated reviewer routing with concrete implementation detail and realistic wording.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', `agent:${taskId}-reviewer`
            ]);
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath,
                reviewerIdentity: `agent:${taskId}-reviewer`
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', `agent:${taskId}-reviewer`
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const receipt = JSON.parse(fs.readFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), 'utf8'));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, `agent:${taskId}-reviewer`);
        assert.equal(receipt.reviewer_fallback_reason, null);
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, `agent:${taskId}-reviewer`);
        assert.equal(reviewContext.reviewer_routing.fallback_reason, null);
        assert.ok(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'));
        assert.ok(events.some((event) => event.event_type === 'REVIEW_RECORDED'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing and record-review-receipt honor an explicit custom task-mode artifact path when the default artifact drifts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-routing-receipt';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        const outputFiltersPath = path.resolve('live/config/output-filters.json');

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Honor explicit custom task-mode evidence across split routing and receipt recording',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for split routing and receipt custom task-mode path regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.mkdirSync(path.dirname(defaultTaskModePath), { recursive: true });
        fs.writeFileSync(defaultTaskModePath, JSON.stringify({
            timestamp_utc: '2026-04-17T12:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Drifted default task-mode artifact for split routing/receipt regression coverage',
            provider: 'Qwen',
            routed_to: 'QWEN.md',
            canonical_source_of_truth: 'Qwen',
            execution_provider: 'Qwen',
            execution_provider_source: 'task_mode',
            runtime_identity_status: 'resolved'
        }, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let buildExitCode = 0;
        let routingExitCode = 0;
        let receiptExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', reviewContextPath
            ]);
            buildExitCode = Number(process.exitCode ?? 0);

            const builtReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = builtReviewContext.reviewer_routing as Record<string, unknown>;
            assert.equal(reviewerRouting.canonical_source_of_truth, 'Codex');
            assert.equal(reviewerRouting.execution_provider, 'Antigravity');
            assert.equal(reviewerRouting.source_of_truth, 'Antigravity');

            fs.writeFileSync(artifactPath, [
                '# Review',
                '',
                'Validated `src/cli/commands/gate-review-handlers.ts`, `src/gates/reviewer-routing.ts`, and the split routing/receipt lifecycle, confirming that the explicit custom task-mode artifact path remains authoritative even when a conflicting default task-mode artifact exists.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--review-context-path', reviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            routingExitCode = Number(process.exitCode ?? 0);
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath,
                reviewerIdentity: 'agent:code-reviewer'
            });

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-context-path', reviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            receiptExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildExitCode, 0);
        assert.equal(routingExitCode, 0);
        assert.equal(receiptExitCode, 0);

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing as Record<string, unknown>;
        const receipt = JSON.parse(fs.readFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), 'utf8')) as Record<string, unknown>;
        const events = readTaskTimelineEvents(repoRoot, taskId);

        assert.equal(reviewerRouting.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewerRouting.reviewer_session_id, 'agent:code-reviewer');
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');
        assert.ok(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'));
        assert.ok(events.some((event) => event.event_type === 'REVIEW_RECORDED'));

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            taskModePath: customTaskModePath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Custom task-mode path split routing/receipt regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId,
            taskModePath: customTaskModePath
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects stale staged review contexts after reviewer-visible tree drift', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-staged-result-drift';
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

        const reviewerIdentity = 'agent:test-staged-result-drift-reviewer';
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
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath,
            reviewerIdentity
        });

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const value = 3;\n', 'utf8');
        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated the staged review snapshot and current reviewer launch telemetry for `src/app.ts` after the delegated reviewer finished.',
            '',
            '## Validation Notes',
            'Reviewed `src/app.ts` against the staged review snapshot, current reviewer launch telemetry, and stale working-tree boundary so the result ingestion path can reach tree-state validation.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const result = await runCliWithCapturedOutput([
            'gate',
            'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', preflightPath,
            '--review-output-path', reviewOutputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.ok(
            result.errors.some((line) => line.includes('record-review-result cannot continue because the current reviewer-visible tree state is stale')),
            result.errors.join('\n')
        );
        assert.ok(
            result.errors.some((line) => line.includes('Staged review scope is stale: src/app.ts has unstaged working-tree changes')),
            result.errors.join('\n')
        );
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-code.md`)), false);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects stale reviewer prompt artifacts before materializing review output', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-265-stale-prompt-result';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated the reviewer prompt binding path, the invocation telemetry dependency, and the review context rule_context artifact hash before writing the final review artifact for src/app.ts. This content is intentionally specific enough to pass the review materialization guard so the test reaches the prompt freshness check.',
            '',
            '## Validation Notes',
            'Reviewed `src/app.ts`, the reviewer prompt binding path, invocation telemetry dependency, and review-context artifact hash so this fixture reaches the prompt freshness guard.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        fs.writeFileSync(fixture.reviewerPromptPath, 'stale reviewer prompt payload before result recording\n', 'utf8');
        const result = await runCliWithCapturedOutput([
            'gate',
            'record-review-result',
            '--task-id', taskId,
            '--review-type', 'code',
            '--preflight-path', fixture.preflightPath,
            '--review-output-path', reviewOutputPath,
            '--repo-root', repoRoot,
            '--reviewer-execution-mode', 'delegated_subagent',
            '--reviewer-identity', fixture.reviewerIdentity
        ], { cwd: repoRoot });

        assert.notEqual(result.exitCode, 0);
        assert.ok(
            result.errors.some((line) => line.includes('record-review-result cannot continue because reviewer prompt artifact is stale')),
            result.errors.join('\n')
        );
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result accepts legacy review-context identity when task-mode runtime identity is backfilled safely', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-legacy-backfill';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Record a review against a legacy provider-bridge review-context after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy provider-bridge task-mode entry before runtime identity split.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Record a review against a legacy provider-bridge review-context after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        });
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');

        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, taskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');

        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath).exitCode, 0);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation resumed after upgrade on a legacy provider-bridge task-mode artifact.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const crypto = require('node:crypto');
        const preflightText = fs.readFileSync(preflightPath, 'utf8');
        const preflightSha256 = crypto.createHash('sha256').update(preflightText).digest('hex');
        const reviewSnapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/app.ts']);
        const reviewTreeState = buildReviewTreeState({
            repoRoot,
            detectionSource: 'explicit_changed_files',
            includeUntracked: true,
            changedFiles: ['src/app.ts'],
            metrics: {
                changed_files_sha256: reviewSnapshot.changed_files_sha256,
                scope_content_sha256: reviewSnapshot.scope_content_sha256,
                scope_sha256: reviewSnapshot.scope_sha256
            }
        });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            schema_version: 2,
            task_id: taskId,
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            tree_state: reviewTreeState,
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: preflightSha256,
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers.ts`, `src/gates/review-context-routing.ts`, and the legacy provider-bridge resume path, confirming that legacy review-context routing metadata can still be materialized after runtime identity is safely backfilled from a provider bridge while receipt, routing telemetry, and canonical artifact writes remain bound to the active preflight and task-mode evidence.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'code',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--review-context-path', reviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.source_of_truth, 'Codex');
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects delegated reviewer receipts when controller routing telemetry is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-missing-route';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated that delegated review materialization must bind to controller-routed telemetry rather than self-minting it during receipt persistence.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            console.error = (...args: unknown[]) => {
                capturedErrors.push(args.map((value) => String(value)).join(' '));
            };
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(reviewOutputPath), true);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        assert.ok(capturedErrors.length > 0);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects delegated reviewer receipts when invocation attestation is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-missing-invocation-attestation';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers/index.ts` for the negative delegated-review trust path: a routed delegated review still cannot materialize as independent evidence until reviewer invocation attestation exists for the same review context hash, reviewer identity, execution mode, and routing event hash. This fixture intentionally records only `REVIEWER_DELEGATION_ROUTED` and omits `REVIEWER_INVOCATION_ATTESTED`.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Delegated review routed without launch attestation.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:code-reviewer',
            delegation_used: true
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            console.error = (...args: unknown[]) => {
                capturedErrors.push(args.map((value) => String(value)).join(' '));
            };
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(reviewOutputPath), true);
        assert.ok(
            capturedErrors.some((entry) => entry.includes('REVIEWER_INVOCATION_ATTESTED launch provenance')),
            capturedErrors.join('\n')
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), true);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result blocks downstream test review materialization until upstream code review passes current cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-record-test-review-blocked';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-record-review-blocked.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Block downstream test review materialization until upstream code review passes current cycle',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-manual-test-context.json`);
        const testReviewOutputPath = path.join(reviewsRoot, `${taskId}-test-review-output.md`);
        const testReviewArtifactPath = path.join(reviewsRoot, `${taskId}-test.md`);
        const testReviewReceiptPath = testReviewArtifactPath.replace(/\.md$/, '-receipt.json');
        fs.writeFileSync(testReviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'test'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'test'),
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(testReviewOutputPath, [
            '# Review',
            '',
            'Validated the downstream test-review materialization path against current-cycle review sequencing evidence, including `src/gates/review-dependencies.ts` and the `T-904b-record-test-review-blocked-test-review-context.json` binding that should stay blocked until code review passes. The review body also calls out current-cycle receipt binding and dependency ordering so it is substantive even with no active findings.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'TEST REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const blockedErrors: string[] = [];
        process.exitCode = 0;
        let blockedExitCode = 0;
        try {
            process.chdir(repoRoot);
            console.error = (...args: unknown[]) => {
                blockedErrors.push(args.map((value) => String(value)).join(' '));
            };
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--review-output-path', testReviewOutputPath,
                '--review-context-path', testReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            blockedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const blockedErrorOutput = blockedErrors.join('\n');
        assert.ok(blockedExitCode !== 0, `Expected non-zero exit code, got ${blockedExitCode}`);
        assert.ok(
            blockedErrorOutput.includes("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code."),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('BlockerTaxonomy: missing_upstream_pass=code'),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('code: [missing_upstream_pass] no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'),
            blockedErrorOutput
        );
        assert.equal(fs.existsSync(testReviewArtifactPath), false);
        assert.equal(fs.existsSync(testReviewReceiptPath), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        )), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context, record-review-result, required-reviews-check, and completion honor an explicit custom task-mode artifact path end-to-end', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-end-to-end';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
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
            }
        });
        const outputFiltersPath = path.resolve('live/config/output-filters.json');

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Honor an explicit custom task-mode artifact path across review and closeout gates',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for custom task-mode path regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const driftedDefaultTaskMode = JSON.parse(fs.readFileSync(customTaskModePath, 'utf8')) as Record<string, unknown>;
        driftedDefaultTaskMode.provider = 'Codex';
        driftedDefaultTaskMode.routed_to = 'AGENTS.md';
        driftedDefaultTaskMode.canonical_source_of_truth = 'Codex';
        driftedDefaultTaskMode.execution_provider = 'Codex';
        driftedDefaultTaskMode.execution_provider_source = 'task_mode.provider';
        driftedDefaultTaskMode.runtime_identity_status = 'resolved';
        fs.mkdirSync(path.dirname(defaultTaskModePath), { recursive: true });
        fs.writeFileSync(defaultTaskModePath, JSON.stringify(driftedDefaultTaskMode, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const customCodeReviewContextPath = path.join(reviewsRoot, 'custom-task-mode-code-review-context.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', customCodeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            const builtReviewContext = JSON.parse(fs.readFileSync(customCodeReviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = builtReviewContext.reviewer_routing as Record<string, unknown>;
            assert.equal(reviewerRouting.canonical_source_of_truth, 'Codex');
            assert.equal(reviewerRouting.execution_provider, 'Antigravity');
            assert.equal(reviewerRouting.source_of_truth, 'Antigravity');
            assert.equal(reviewerRouting.fresh_context_required, true);
            assert.equal(reviewerRouting.reviewer_session_reuse_forbidden, true);
            assert.equal(reviewerRouting.cleanup_required_after_receipt, true);
            assert.ok(String(reviewerRouting.fresh_context_instruction || '').includes('new clean-context delegated reviewer'));
            assert.ok(String(reviewerRouting.reviewer_session_reuse_note || '').includes('not valid fresh-context launch evidence'));
            assert.ok(String(reviewerRouting.cleanup_instruction || '').includes('close or release the reviewer sub-agent session'));

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/gates/build-review-context.ts`, `src/cli/commands/gate-review-handlers.ts`, `src/cli/commands/gate-flows/review-flow.ts`, and `src/gates/completion.ts`, confirming that the explicit custom task-mode artifact path remains authoritative through review materialization, review-gate verification, and completion-gate closeout even when a conflicting default task-mode artifact exists.',
                '',
                '## Validation Notes',
                'Reviewed `src/gates/build-review-context.ts`, `src/cli/commands/gate-review-handlers.ts`, `src/cli/commands/gate-flows/review-flow.ts`, and `src/gates/completion.ts` for explicit custom task-mode path authority across review materialization and closeout.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--review-context-path', customCodeReviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: customCodeReviewContextPath,
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--review-output-path', codeReviewOutputPath,
                '--review-context-path', customCodeReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(codeReviewBuildExitCode, 0);
        assert.equal(codeReviewRecordExitCode, 0);

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            taskModePath: customTaskModePath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Custom task-mode path regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId,
            taskModePath: customTaskModePath
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context and record-review-result honor explicit custom task-mode paths for downstream test-review dependency checks', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-downstream-test';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Honor an explicit custom task-mode path when unblocking downstream test review',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for downstream custom task-mode dependency regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const driftedDefaultTaskMode = JSON.parse(fs.readFileSync(customTaskModePath, 'utf8')) as Record<string, unknown>;
        driftedDefaultTaskMode.provider = 'Codex';
        driftedDefaultTaskMode.routed_to = 'AGENTS.md';
        driftedDefaultTaskMode.canonical_source_of_truth = 'Codex';
        driftedDefaultTaskMode.execution_provider = 'Codex';
        driftedDefaultTaskMode.execution_provider_source = 'task_mode.provider';
        driftedDefaultTaskMode.runtime_identity_status = 'resolved';
        fs.mkdirSync(path.dirname(defaultTaskModePath), { recursive: true });
        fs.writeFileSync(defaultTaskModePath, JSON.stringify(driftedDefaultTaskMode, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const customCodeReviewContextPath = path.join(reviewsRoot, 'custom-task-mode-downstream-code-context.json');
        const customTestReviewContextPath = path.join(reviewsRoot, 'custom-task-mode-downstream-test-context.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const testReviewOutputPath = path.join(reviewsRoot, `${taskId}-test-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        let testReviewBuildExitCode = 0;
        let testReviewRecordExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', customCodeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/gates/review-dependencies.ts`, `src/cli/commands/gate-build-handlers.ts`, and `src/cli/commands/gate-review-handlers.ts`, confirming that upstream code-review evidence remains bound to the explicit custom task-mode artifact path even when a drifted default task-mode artifact exists.',
                '',
                '## Validation Notes',
                'Reviewed `src/gates/review-dependencies.ts`, `src/cli/commands/gate-build-handlers.ts`, and `src/cli/commands/gate-review-handlers.ts` for upstream code-review evidence bound to the explicit custom task-mode artifact path.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--review-context-path', customCodeReviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'code',
                reviewContextPath: customCodeReviewContextPath,
                reviewerIdentity: 'agent:code-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--review-output-path', codeReviewOutputPath,
                '--review-context-path', customCodeReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', customTestReviewContextPath
            ]);
            testReviewBuildExitCode = Number(process.exitCode ?? 0);

            const builtTestReviewContext = JSON.parse(fs.readFileSync(customTestReviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = builtTestReviewContext.reviewer_routing as Record<string, unknown>;
            assert.equal(reviewerRouting.execution_provider, 'Antigravity');
            assert.equal(reviewerRouting.canonical_source_of_truth, 'Codex');

            fs.writeFileSync(testReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/gates/review-dependencies.ts`, `src/cli/commands/gate-build-handlers.ts`, and `src/cli/commands/gate-review-handlers.ts`, confirming that downstream test-review dependency checks now stay bound to the explicit custom task-mode artifact path instead of falling back to a drifted default task-mode artifact.',
                '',
                '## Validation Notes',
                'Reviewed `src/gates/review-dependencies.ts`, `src/cli/commands/gate-build-handlers.ts`, and `src/cli/commands/gate-review-handlers.ts` for downstream test-review dependency checks bound to the explicit custom task-mode artifact path.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'TEST REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'test',
                '--review-context-path', customTestReviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            attestReviewerInvocationForTest({
                repoRoot,
                taskId,
                reviewType: 'test',
                reviewContextPath: customTestReviewContextPath,
                reviewerIdentity: 'agent:test-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--review-output-path', testReviewOutputPath,
                '--review-context-path', customTestReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            testReviewRecordExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(codeReviewBuildExitCode, 0);
        assert.equal(codeReviewRecordExitCode, 0);
        assert.equal(testReviewBuildExitCode, 0);
        assert.equal(testReviewRecordExitCode, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
