import {
    describe,
    it,
    assert,
    fs,
    os,
    path,
    EXIT_GATE_FAILURE,
    runBuildReviewContextCommand,
    runRequiredReviewsCheckCommand,
    runCliMainWithHandling,
    validateReviewSkillEvidence,
    applyReviewerRoutingMetadata,
    appendTaskEvent,
    createTempRepo,
    findLastTimelineEventIndex,
    getOrchestratorRoot,
    getReviewsRoot,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    readTaskTimelineEvents,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeCompilePassEvidence,
    writePreflight,
    insertTaskEventWithoutIntegrityBeforeLatest,
    tamperLatestHistoricalReceiptSnapshot,
    tamperLatestHistoricalArtifactSnapshot,
    listReviewSnapshotArtifactNames
} from './gates-review-reuse-fixtures';

describe('cli/commands/gates - review reuse remediation', () => {
    it('build-review-context rejects late review preparation after the review gate already passed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-late-build';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewContextArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-context.json`);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Required reviews gate passed.', {});

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(reviewContextArtifactPath), false);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_PHASE_STARTED'), false);
        assert.equal(events.some((event) => event.event_type === 'SKILL_SELECTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result restores existing receipt and historical snapshots when review-recorded telemetry is blocked', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-record-review-result-rollback-preserves-snapshots';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve existing review evidence when REVIEW_RECORDED telemetry cannot be persisted'
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:old-code-reviewer');

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const oldReceiptText = fs.readFileSync(receiptPath, 'utf8');
        const oldSnapshotNames = listReviewSnapshotArtifactNames(reviewsRoot, taskId, 'code');
        const oldArtifactText = fs.readFileSync(path.join(reviewsRoot, `${taskId}-code.md`), 'utf8');

        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        const newReviewerIdentity = 'agent:new-code-reviewer';
        const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'new code review routing recorded', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: newReviewerIdentity,
            delegation_used: true,
            reviewer_fallback_reason: null
        }, { passThru: true });
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: newReviewerIdentity,
            fallbackReason: null
        });
        const crypto = require('node:crypto');
        const reviewContextSha256 = crypto.createHash('sha256')
            .update(fs.readFileSync(reviewContextPath))
            .digest('hex');
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', 'new code reviewer invocation attested', {
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: newReviewerIdentity,
            reviewer_identity: newReviewerIdentity,
            review_context_sha256: reviewContextSha256,
            routing_event_sha256: routedEvent?.integrity?.event_sha256
        });

        const reviewOutputPath = path.join(repoRoot, '.review-temp', taskId, 'code', 'review-output.md');
        fs.mkdirSync(path.dirname(reviewOutputPath), { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers/index.ts` rollback behavior for review receipt materialization when telemetry append is blocked after an existing review receipt and immutable snapshots already exist. This reviewer output intentionally describes the receipt path, receipt snapshot path, artifact snapshot path, and task-event append boundary so the materialized review is substantive before the lock-induced persistence failure is exercised.',
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

        const taskEventsRoot = path.join(orchestratorRoot, 'runtime', 'task-events');
        const lockPath = path.join(taskEventsRoot, `.${taskId}.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', newReviewerIdentity
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0);
        assert.equal(fs.readFileSync(receiptPath, 'utf8'), oldReceiptText);
        assert.deepEqual(listReviewSnapshotArtifactNames(reviewsRoot, taskId, 'code'), oldSnapshotNames);
        assert.equal(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code.md`), 'utf8').trimEnd(),
            oldArtifactText.trimEnd()
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const newRecordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && typeof event.details === 'object'
            && event.details !== null
            && !Array.isArray(event.details)
            && String((event.details as Record<string, unknown>).reviewer_identity || '').trim() === newReviewerIdentity
        ));
        assert.equal(newRecordedEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('review gate rejects reused receipts when CLI-loaded receipt fields diverge from current reuse telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-review-gate-loads-reuse-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Review gate must validate CLI-loaded reused receipt fields'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.reused_from_review_context_reuse_sha256 = '9'.repeat(64);
        fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => (
            line.includes("Review 'code' is missing current-cycle REVIEW_RECORDED reuse telemetry")
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('review gate does not report missing current-cycle reuse telemetry when a later valid event exists', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-review-gate-skips-earlier-invalid-reuse-event';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Review gate should use the latest valid strict reuse telemetry'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        insertTaskEventWithoutIntegrityBeforeLatest(
            repoRoot,
            taskId,
            'REVIEW_RECORDED',
            'PASS',
            'stale current-cycle reuse event without integrity',
            {
                review_type: 'code',
                reused_existing_review: true,
                receipt_path: path.normalize(receiptPath).replace(/\\/g, '/')
            },
            (event) => {
                const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : {};
                return (
                    event.event_type === 'REVIEW_RECORDED'
                    && details.reused_existing_review === true
                    && String(details.review_type || details.reviewType || '').toLowerCase() === 'code'
                );
            }
        );

        // Modify the scoped file after compile-gate to create genuine scope drift,
        // so the review-check correctly detects the workspace changed.
        fs.appendFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), '// post-compile modification\n', 'utf8');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE, reviewResult.outputLines.join('\n'));
        assert.equal(
            reviewResult.outputLines.some((line) => line.includes("Review 'code' is missing current-cycle REVIEW_RECORDED reuse telemetry")),
            false
        );
        assert.equal(
            reviewResult.outputLines.some((line) => line.includes('Workspace changed after compile gate')),
            true
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('review gate rejects reused receipts when the historical source receipt snapshot is tampered after reuse telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-review-gate-rejects-tampered-source-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Review gate must verify historical source receipt snapshots for reused evidence'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        tamperLatestHistoricalReceiptSnapshot(repoRoot, taskId, 'code');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => (
            line.includes('historical REVIEW_RECORDED telemetry')
            || line.includes('current-cycle REVIEW_RECORDED reuse telemetry')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('review gate rejects reused receipts when the historical source artifact snapshot is tampered after reuse telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-review-gate-rejects-tampered-source-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Review gate must verify historical source artifact snapshots for reused evidence'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        tamperLatestHistoricalArtifactSnapshot(repoRoot, taskId, 'code');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => (
            line.includes('historical REVIEW_RECORDED telemetry')
            || line.includes('current-cycle REVIEW_RECORDED reuse telemetry')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion review-skill evidence rejects reused receipts when the historical source receipt snapshot is tampered after reuse telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-completion-rejects-tampered-source-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Completion validation must verify historical source receipt snapshots for reused evidence'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        tamperLatestHistoricalReceiptSnapshot(repoRoot, taskId, 'code');

        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const reviewSkillEvidence = validateReviewSkillEvidence(
            readTaskTimelineEvents(repoRoot, taskId) as any,
            { code: true },
            {
                code: {
                    path: artifactPath,
                    content: fs.readFileSync(artifactPath, 'utf8'),
                    reviewContext: JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>,
                    receipt: JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
                }
            },
            true,
            timelinePath,
            'Qwen',
            'Qwen',
            false,
            'provider_entrypoint',
            undefined,
            repoRoot
        );
        assert.ok(reviewSkillEvidence.violations.some((line) => (
            line.includes('historical REVIEW_RECORDED telemetry')
            || line.includes('current-cycle REVIEW_RECORDED reuse telemetry')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion review-skill evidence rejects reused receipts when the historical source artifact snapshot is tampered after reuse telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-completion-rejects-tampered-source-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Completion validation must verify historical source artifact snapshots for reused evidence'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        tamperLatestHistoricalArtifactSnapshot(repoRoot, taskId, 'code');

        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const reviewSkillEvidence = validateReviewSkillEvidence(
            readTaskTimelineEvents(repoRoot, taskId) as any,
            { code: true },
            {
                code: {
                    path: artifactPath,
                    content: fs.readFileSync(artifactPath, 'utf8'),
                    reviewContext: JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>,
                    receipt: JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
                }
            },
            true,
            timelinePath,
            'Qwen',
            'Qwen',
            false,
            'provider_entrypoint',
            undefined,
            repoRoot
        );
        assert.ok(reviewSkillEvidence.violations.some((line) => (
            line.includes('historical REVIEW_RECORDED telemetry')
            || line.includes('current-cycle REVIEW_RECORDED reuse telemetry')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion review-skill evidence rejects reused receipts when the current review context file drifts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-completion-rejects-current-context-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Completion validation must verify current reused review context files'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);

        const tamperedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        tamperedReviewContext.post_review_tamper = true;
        fs.writeFileSync(reviewContextPath, JSON.stringify(tamperedReviewContext, null, 2) + '\n', 'utf8');

        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const reviewSkillEvidence = validateReviewSkillEvidence(
            readTaskTimelineEvents(repoRoot, taskId) as any,
            { code: true },
            {
                code: {
                    path: artifactPath,
                    content: fs.readFileSync(artifactPath, 'utf8'),
                    reviewContextPath,
                    reviewContext: tamperedReviewContext,
                    receipt: JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
                }
            },
            true,
            timelinePath,
            'Qwen',
            'Qwen',
            false,
            'provider_entrypoint',
            undefined,
            repoRoot
        );
        assert.ok(reviewSkillEvidence.violations.some((line) => (
            line.includes('review_context_sha256 does not match the current review-context file')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence when only the aggregate telemetry index fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-reuse-aggregate-warning';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code review evidence when aggregate telemetry index fails'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        fs.rmSync(aggregatePath, { force: true });
        fs.mkdirSync(aggregatePath, { recursive: true });

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });
        assert.equal(result.reusedReviewEvidence, true);
        assert.equal(result.reusedReviewerExecutionMode, 'delegated_subagent');
        assert.equal(result.reusedReviewerIdentity, 'agent:code-reviewer');
        assert.equal(
            fs.existsSync(aggregatePath) && fs.statSync(aggregatePath).isDirectory(),
            true,
            'fixture must keep aggregate index unavailable while reuse succeeds from canonical task events'
        );

        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(refreshedReceipt.reviewer_identity, 'agent:code-reviewer');
        assert.equal(refreshedReceipt.preflight_sha256, require('node:crypto')
            .createHash('sha256')
            .update(fs.readFileSync(preflightPath, 'utf8'))
            .digest('hex'));
        assert.equal(refreshedReceipt.reused_existing_review, true);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(latestCompileSequence >= 0);
        const currentCycleCodeEvents = events
            .map((event, index) => ({ event, index }))
            .filter(({ event, index }) => (
                index > latestCompileSequence
                && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEWER_INVOCATION_ATTESTED' || event.event_type === 'REVIEW_RECORDED')
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.equal(
            currentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length,
            0
        );
        assert.equal(
            currentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length,
            0
        );
        assert.equal(
            currentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEW_RECORDED').length,
            1
        );
        assert.equal(
            (currentCycleCodeEvents.find(({ event }) => event.event_type === 'REVIEW_RECORDED')?.event.details as Record<string, unknown>).reused_existing_review,
            true
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('preserves delegated reviewer provenance when historical code review evidence is reused in the current cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-delegated-reuse-provenance';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable delegated code review evidence before a pure test-only rerun',
            provider: 'Codex'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');
        const priorReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const priorProvenance = priorReceipt.reviewer_provenance as Record<string, unknown>;

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(refreshedReceipt.reviewer_identity, 'agent:code-reviewer');
        assert.equal(refreshedReceipt.trust_level, 'INDEPENDENT_AUDITED');
        assert.equal(refreshedReceipt.reused_existing_review, true);
        const refreshedProvenance = refreshedReceipt.reviewer_provenance as Record<string, unknown> | null;
        assert.ok(refreshedProvenance);
        assert.deepEqual(refreshedProvenance, priorProvenance);
        assert.equal(refreshedReceipt.reused_from_review_context_sha256, priorReceipt.review_context_sha256);

        const refreshedContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const refreshedRouting = refreshedContext.reviewer_routing as Record<string, unknown>;
        assert.equal(refreshedRouting.actual_execution_mode, null);
        assert.equal(refreshedRouting.reviewer_session_id, null);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(latestCompileSequence >= 0);
        const currentCycleLaunchEvents = events.filter((event, index) => (
            index > latestCompileSequence
            && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEWER_INVOCATION_ATTESTED')
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(currentCycleLaunchEvents.length, 0);

        const recordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.ok(recordedEvents.length >= 1);
        assert.equal((recordedEvents.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not report reuse success when current-cycle reuse telemetry cannot be recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-reuse-telemetry-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before reuse telemetry lock validation'
        });
        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        fs.mkdirSync(taskEventsRoot, { recursive: true });
        const lockPath = path.join(taskEventsRoot, `.${taskId}.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const crypto = require('node:crypto');
        const priorPreflightSha = crypto.createHash('sha256').update(fs.readFileSync(priorPreflightPath, 'utf8')).digest('hex');
        const currentPreflightSha = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        const refreshedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        assert.equal(refreshedReceipt.preflight_sha256, priorPreflightSha);
        assert.notEqual(refreshedReceipt.preflight_sha256, currentPreflightSha);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentCycleCodeEvents = events
            .map((event, index) => ({ event, index }))
            .filter(({ event, index }) => (
                index > latestCompileSequence
                && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEW_RECORDED')
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.equal(currentCycleCodeEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
