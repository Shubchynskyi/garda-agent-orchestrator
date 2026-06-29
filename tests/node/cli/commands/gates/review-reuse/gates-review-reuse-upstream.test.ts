import {
    describe,
    it,
    assert,
    childProcess,
    fs,
    path,
    runBuildReviewContextCommand,
    runCompileGateCommand,
    runRequiredReviewsCheckCommand,
    runCliMainWithHandling,
    computeCodeReviewScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    appendTaskEvent,
    createTempRepo,
    findLastTimelineEventIndex,
    getOrchestratorRoot,
    getReviewsRoot,
    initializeGitRepo,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    readTaskTimelineEvents,
    runEnterTaskMode,
    runExplicitPreflight,
    runHandshakeForTask,
    runShellSmokeForTask,
    resolveReviewerExecutionFixture,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeCompilePassEvidence,
    writePreflight,
    writeReceiptBackedReviewArtifact,
    runGit,
    getReviewTreeStateSha256FromFixtureContext
} from './gates-review-reuse-fixtures';

describe('cli/commands/gates - review reuse upstream reuse', () => {
    it('reuses current-cycle code review evidence and unblocks downstream test review when runtime code scope is unchanged', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-reuse-code-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 5;\nconst b = 7;\nconsole.log(a + b);\n', 'utf8');

        const priorPreflightPath = writePreflight(
            repoRoot,
            taskId,
            {
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
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
            },
            `${taskId}-prior-preflight.json`
        );
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-reuse.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        const codeExecution = resolveReviewerExecutionFixture(taskId, 'Qwen', 'agent:code-reviewer');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code review evidence when only test scope changes'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        writeCompilePassEvidence(repoRoot, taskId, priorPreflightPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, codeExecution.reviewerIdentity);
        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'historical code review started', {
            review_type: 'code'
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'historical code review routing recorded', {
            review_type: 'code',
            reviewer_execution_mode: codeExecution.reviewerExecutionMode,
            reviewer_session_id: codeExecution.reviewerIdentity,
            delegation_used: codeExecution.reviewerExecutionMode === 'delegated_subagent',
            reviewer_fallback_reason: codeExecution.reviewerFallbackReason
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'historical code review recorded', {
            review_type: 'code',
            reused_existing_review: false
        });
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reuse code review evidence when only test scope changes',
            ['src/app.ts', 'tests/app.test.ts']
        );
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
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot
            ]);
            writeReceiptBackedReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', [
                '# Test Review',
                '',
                'Validated `tests/app.test.ts` and the rerun-only scope for the fresh review cycle. This review artifact is intentionally detailed enough to satisfy the anti-triviality check while reporting no concrete failures for the updated test surface.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'TEST REVIEW PASSED'
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(refreshedReceipt.reviewer_identity, codeExecution.reviewerIdentity);
        assert.equal(refreshedReceipt.reused_existing_review, true);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(
            refreshedReceipt.review_tree_state_sha256,
            getReviewTreeStateSha256FromFixtureContext(reviewContext)
        );
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-test-review-context.json`)), true);
        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            testReviewVerdict: 'TEST REVIEW PASSED',
            reviewAuthorshipAttestationJson: '{"code":true,"test":true}',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewGateResult.exitCode, 0, reviewGateResult.outputLines.join('\n'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        let latestCompileSequence = -1;
        for (let index = events.length - 1; index >= 0; index -= 1) {
            if (events[index].event_type === 'COMPILE_GATE_PASSED') {
                latestCompileSequence = index;
                break;
            }
        }
        const reviewPhaseSequences = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => (
                event.event_type === 'REVIEW_PHASE_STARTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ))
            .map(({ index }) => index);
        const recordedEvents = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => (
                event.event_type === 'REVIEW_RECORDED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.ok(latestCompileSequence >= 0);
        assert.ok(reviewPhaseSequences.some((sequence) => sequence < latestCompileSequence));
        assert.ok(recordedEvents.some(({ index }) => index < latestCompileSequence));
        assert.equal(recordedEvents.some(({ index }) => index > latestCompileSequence), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence for a pure test-only rerun', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-test-only-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before a pure test-only rerun'
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
        const receiptReboundContextSha256 = 'f'.repeat(64);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer', {
            receiptReviewContextSha256Override: receiptReboundContextSha256
        });
        const priorReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const priorProvenance = priorReceipt.reviewer_provenance as Record<string, unknown>;
        assert.equal(priorReceipt.review_context_sha256, receiptReboundContextSha256);
        assert.notEqual(priorProvenance.review_context_sha256, priorReceipt.review_context_sha256);

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
        const refreshedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        assert.equal(
            refreshedReceipt.review_tree_state_sha256,
            getReviewTreeStateSha256FromFixtureContext(refreshedReviewContext)
        );
        assert.equal(
            refreshedReceipt.reused_from_review_tree_state_sha256,
            priorReceipt.review_tree_state_sha256
        );
        assert.equal(
            refreshedReceipt.reused_from_review_context_sha256,
            priorReceipt.review_context_sha256
        );
        assert.equal(
            refreshedReceipt.code_scope_sha256,
            computeCodeReviewScopeFingerprint(JSON.parse(fs.readFileSync(preflightPath, 'utf8')), repoRoot).code_scope_sha256
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const recordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.ok(recordedEvents.length >= 1);
        assert.equal((recordedEvents.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);

        const firstReuseProvenance = refreshedReceipt.reviewer_provenance as Record<string, unknown>;
        const secondPreflightPath = writePreflight(repoRoot, taskId, {
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
        writeCompilePassEvidence(repoRoot, taskId, secondPreflightPath);

        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', secondPreflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const secondRefreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(secondRefreshedReceipt.reused_existing_review, true);
        assert.deepEqual(secondRefreshedReceipt.reviewer_provenance, firstReuseProvenance);
        assert.equal(
            secondRefreshedReceipt.reused_from_review_context_sha256,
            priorReceipt.review_context_sha256
        );
        assert.equal(
            secondRefreshedReceipt.reused_from_receipt_sha256,
            refreshedReceipt.reused_from_receipt_sha256
        );
        assert.equal(
            secondRefreshedReceipt.reused_from_review_tree_state_sha256,
            refreshedReceipt.reused_from_review_tree_state_sha256
        );
        assert.equal(
            secondRefreshedReceipt.reused_from_review_scope_sha256,
            refreshedReceipt.reused_from_review_scope_sha256
        );
        const secondEvents = readTaskTimelineEvents(repoRoot, taskId);
        const secondLatestCompileSequence = findLastTimelineEventIndex(secondEvents, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const secondCurrentCycleCodeEvents = secondEvents
            .map((event, index) => ({ event, index }))
            .filter(({ event, index }) => (
                index > secondLatestCompileSequence
                && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEWER_INVOCATION_ATTESTED' || event.event_type === 'REVIEW_RECORDED')
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.equal(secondCurrentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 0);
        assert.equal(secondCurrentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        assert.equal(secondCurrentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEW_RECORDED').length, 1);

        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', secondPreflightPath,
                '--repo-root', repoRoot
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-test-review-context.json`)), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('skips rebuilding an unchanged current-cycle PASS review context', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-context-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse current-cycle PASS review context when bindings are unchanged'
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:code-reviewer');

        const originalContextText = fs.readFileSync(reviewContextPath, 'utf8');
        const originalReceiptText = fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8');
        const eventsBefore = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(
            eventsBefore,
            (event) => event.event_type === 'COMPILE_GATE_PASSED'
        );
        assert.ok(latestCompileSequence >= 0);
        const currentCycleCodeReviewPhaseCount = eventsBefore.filter((event, index) => {
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : {};
            return (
                index > latestCompileSequence
                && event.event_type === 'REVIEW_PHASE_STARTED'
                && String(details.review_type || '').trim().toLowerCase() === 'code'
            );
        }).length;
        assert.equal(currentCycleCodeReviewPhaseCount, 1);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: True'));
        assert.ok(result.outputLines.some((line) => line.includes('review context rebuild skipped')));
        assert.equal(fs.readFileSync(reviewContextPath, 'utf8'), originalContextText);
        assert.equal(fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8'), originalReceiptText);
        const eventsAfter = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(eventsAfter.length, eventsBefore.length + 1);
        const reuseAcceptedEvent = eventsAfter.at(-1);
        assert.equal(reuseAcceptedEvent?.event_type, 'REVIEW_CONTEXT_REUSE_ACCEPTED');
        assert.equal(reuseAcceptedEvent?.outcome, 'PASS');
        const reuseAcceptedDetails = reuseAcceptedEvent?.details as Record<string, unknown>;
        assert.equal(reuseAcceptedDetails.review_type, 'code');
        assert.equal(reuseAcceptedDetails.current_pass_review_evidence, true);
        assert.equal(reuseAcceptedDetails.output_path, reviewContextPath.replace(/\\/g, '/'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses matching historical code-review evidence when later mutable and recorded receipts were overwritten by polluted scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-historical-reuse-after-receipt-overwrite';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse historical code review evidence after mutable receipt overwrite'
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

        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const originalArtifactText = fs.readFileSync(artifactPath, 'utf8');
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const originalHistoricalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
            .reverse()
            .find((event) => (
                event.event_type === 'REVIEW_RECORDED'
                && typeof event.details === 'object'
                && event.details !== null
                && !Array.isArray(event.details)
                && String((event.details as Record<string, unknown>).review_type || '').trim() === 'code'
            ));
        assert.ok(originalHistoricalReviewRecorded);
        const originalHistoricalDetails = originalHistoricalReviewRecorded.details as Record<string, unknown>;
        const originalReceiptSnapshotSha256 = String(originalHistoricalDetails.receipt_snapshot_sha256 || '').trim();
        assert.ok(originalReceiptSnapshotSha256);
        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
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
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        const pollutedArtifactText = [
            '# Review',
            '',
            'This later polluted review artifact represents a real subsequent review cycle that overwrote the canonical markdown artifact for a broader scope.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(artifactPath, pollutedArtifactText, 'utf8');
        const crypto = require('node:crypto');
        const pollutedArtifactHash = crypto
            .createHash('sha256')
            .update(pollutedArtifactText)
            .digest('hex');
        const pollutedArtifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${pollutedArtifactHash}.md`);
        fs.writeFileSync(pollutedArtifactSnapshotPath, pollutedArtifactText, 'utf8');
        const overwrittenReceipt = {
            ...originalReceipt,
            review_artifact_sha256: pollutedArtifactHash,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        };
        assert.notEqual(overwrittenReceipt.code_scope_sha256, originalReceipt.code_scope_sha256);
        writeCompilePassEvidence(repoRoot, taskId, pollutedPreflightPath);
        const pollutedReceiptText = JSON.stringify(overwrittenReceipt, null, 2) + '\n';
        const pollutedReceiptHash = crypto.createHash('sha256').update(pollutedReceiptText).digest('hex');
        const pollutedReceiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${pollutedReceiptHash}.json`);
        fs.writeFileSync(receiptPath, pollutedReceiptText, 'utf8');
        fs.writeFileSync(pollutedReceiptSnapshotPath, pollutedReceiptText, 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'polluted review recorded', {
            ...overwrittenReceipt,
            receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
            receipt_sha256: pollutedReceiptHash,
            receipt_snapshot_path: path.normalize(pollutedReceiptSnapshotPath).replace(/\\/g, '/'),
            receipt_snapshot_sha256: pollutedReceiptHash,
            review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
            review_artifact_snapshot_path: path.normalize(pollutedArtifactSnapshotPath).replace(/\\/g, '/'),
            review_artifact_snapshot_sha256: pollutedArtifactHash,
            review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/')
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, true);
        assert.ok(result.outputLines.some((line) => line.includes('matched historical REVIEW_RECORDED')));
        assert.ok(result.outputLines.some((line) => line.includes('rejected latest mutable receipt')));
        const refreshedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reused_existing_review, true);
        assert.equal(refreshedReceipt.reused_from_receipt_sha256, originalReceiptSnapshotSha256);
        assert.notEqual(refreshedReceipt.reused_from_receipt_sha256, pollutedReceiptHash);
        assert.equal(refreshedReceipt.reused_from_code_scope_sha256, originalReceipt.code_scope_sha256);
        assert.notEqual(refreshedReceipt.reused_from_code_scope_sha256, overwrittenReceipt.code_scope_sha256);
        assert.equal(refreshedReceipt.reused_from_review_scope_sha256, originalReceipt.review_scope_sha256);
        assert.equal(fs.readFileSync(artifactPath, 'utf8'), originalArtifactText);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence for a docs-only post-review delta', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-docs-only-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n- Updated docs.\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before a docs-only delta'
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
            scope_category: 'docs-only',
            changed_files: ['CHANGELOG.md'],
            metrics: { changed_lines_total: 2 },
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
        assert.equal(
            refreshedReceipt.code_scope_sha256,
            computeCodeReviewScopeFingerprint(JSON.parse(fs.readFileSync(preflightPath, 'utf8')), repoRoot).code_scope_sha256
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const recordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.ok(recordedEvents.length >= 1);
        assert.equal((recordedEvents.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code and test review evidence when only changelog is added after reviews', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-docs-only-code-test-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code and test review evidence after changelog-only delta'
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
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, testReviewContextPath, 'agent:test-reviewer');

        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Documented the user-visible change.\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'CHANGELOG.md'],
            metrics: { changed_lines_total: 4 },
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

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(codeBuild.outputLines.some((line) => line.startsWith('ReviewReuseReason: accepted:')));

        const testBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'test',
            depth: 2,
            preflightPath,
            outputPath: testReviewContextPath
        });
        assert.equal(testBuild.reusedReviewEvidence, true);

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const refreshedTestReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-test-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(
            refreshedTestReceipt.review_scope_sha256,
            computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const testRecordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        assert.equal((testRecordedEvents.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior review evidence across review-cycle limit-only workflow config changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-workflow-limits-review-reuse';
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        const workflowConfigRelativePath = 'garda-agent-orchestrator/live/config/workflow-config.json';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        initializeGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewedFeature = true;\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse reviews after one-shot limit configuration drift'
        });

        const reviewsRoot = getReviewsRoot(repoRoot);
        const requiredReviews = {
            code: true,
            db: false,
            security: true,
            refactor: true,
            api: false,
            test: true,
            performance: false,
            infra: false,
            dependency: false
        };
        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: requiredReviews
        }, `${taskId}-prior-preflight.json`);
        const reviewTypes = [
            ['code', 'REVIEW PASSED', 'agent:code-reviewer'],
            ['security', 'SECURITY REVIEW PASSED', 'agent:security-reviewer'],
            ['refactor', 'REFACTOR REVIEW PASSED', 'agent:refactor-reviewer'],
            ['test', 'TEST REVIEW PASSED', 'agent:test-reviewer']
        ] as const;
        for (const [reviewType, verdict, reviewerIdentity] of reviewTypes) {
            seedReusableReviewEvidence(
                repoRoot,
                taskId,
                reviewType,
                verdict,
                priorPreflightPath,
                path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`),
                reviewerIdentity
            );
        }

        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, any>;
        workflowConfig.review_cycle_guard.max_failed_non_test_reviews += 1;
        workflowConfig.review_cycle_guard.max_total_non_test_reviews += 1;
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2) + '\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', workflowConfigRelativePath],
            metrics: { changed_lines_total: 5 },
            triggers: { changed_workflow_config_files: [workflowConfigRelativePath] },
            required_reviews: requiredReviews
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        for (const [reviewType] of reviewTypes) {
            const build = await runBuildReviewContextCommand({
                repoRoot,
                reviewType,
                depth: 2,
                preflightPath,
                outputPath: path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`)
            });
            assert.equal(build.reusedReviewEvidence, true, `${reviewType} review should be reused`);
            assert.ok(build.outputLines.includes('ReviewReuseDecision: accepted'));
        }

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint('security', preflight, repoRoot);
        const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight, repoRoot);
        assert.deepEqual(codeScopeFingerprint.review_reuse_neutral_config_files, [workflowConfigRelativePath]);
        assert.deepEqual(reviewScopeFingerprint.review_reuse_neutral_config_files, [workflowConfigRelativePath]);
        assert.equal(codeScopeFingerprint.non_test_changed_files.includes(workflowConfigRelativePath), false);
        assert.equal(reviewScopeFingerprint.review_relevant_changed_files.includes(workflowConfigRelativePath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps task-owned manual-validation evidence out of non-test code scope but not generic review scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-manual-validation-neutral-reuse';
        const reviewsRoot = getReviewsRoot(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse non-test reviews after manual-validation evidence refresh'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 2 }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            priorPreflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );
        const priorPreflight = JSON.parse(fs.readFileSync(priorPreflightPath, 'utf8')) as Record<string, unknown>;
        const priorCodeScope = computeReviewReuseCodeScopeFingerprint('code', priorPreflight, repoRoot);
        const priorReviewScope = computeReviewRelevantScopeFingerprint(priorPreflight, repoRoot);
        const evidencePath = `garda-agent-orchestrator/runtime/manual-validation/${taskId}/review-evidence.json`;
        const selectorPath = `garda-agent-orchestrator/runtime/manual-validation/${taskId}/selector.json`;
        const logPath = `garda-agent-orchestrator/runtime/manual-validation/${taskId}/gradle-test.log`;
        fs.mkdirSync(path.dirname(path.join(repoRoot, evidencePath)), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, evidencePath), JSON.stringify({ task_id: taskId }) + '\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, selectorPath), JSON.stringify({ files: [logPath] }) + '\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, logPath), 'BUILD SUCCESSFUL\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', evidencePath, selectorPath, logPath],
            metrics: { changed_lines_total: 4 }
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
        const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

        assert.deepEqual(codeScopeFingerprint.review_reuse_neutral_evidence_files, [logPath, evidencePath, selectorPath]);
        assert.deepEqual(reviewScopeFingerprint.review_reuse_neutral_evidence_files, []);
        assert.equal(codeScopeFingerprint.non_test_changed_files.includes(evidencePath), false);
        assert.equal(codeScopeFingerprint.non_test_changed_files.includes(selectorPath), false);
        assert.equal(codeScopeFingerprint.non_test_changed_files.includes(logPath), false);
        assert.equal(reviewScopeFingerprint.review_relevant_changed_files.includes(evidencePath), true);
        assert.equal(reviewScopeFingerprint.review_relevant_changed_files.includes(selectorPath), true);
        assert.equal(reviewScopeFingerprint.review_relevant_changed_files.includes(logPath), true);
        assert.equal(codeScopeFingerprint.code_scope_sha256, priorCodeScope.code_scope_sha256);
        assert.notEqual(reviewScopeFingerprint.review_scope_sha256, priorReviewScope.review_scope_sha256);

        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(codeBuild.outputLines.some((line) => line.startsWith('ReviewReuseReason: accepted:')));

        const otherTaskSelectorPath = 'garda-agent-orchestrator/runtime/manual-validation/T-OTHER/review-evidence.json';
        const otherTaskPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', otherTaskSelectorPath],
            metrics: { changed_lines_total: 4 }
        }, `${taskId}-other-task-preflight.json`);
        const otherTaskPreflight = JSON.parse(fs.readFileSync(otherTaskPreflightPath, 'utf8')) as Record<string, unknown>;
        const otherTaskCodeScope = computeReviewReuseCodeScopeFingerprint('code', otherTaskPreflight, repoRoot);

        assert.deepEqual(otherTaskCodeScope.review_reuse_neutral_evidence_files, []);
        assert.equal(otherTaskCodeScope.non_test_changed_files.includes(otherTaskSelectorPath), true);
        assert.notEqual(otherTaskCodeScope.code_scope_sha256, priorCodeScope.code_scope_sha256);

        const symlinkPath = selectorPath;
        const symlinkBlob = childProcess.spawnSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: repoRoot,
            input: 'src/app.ts',
            encoding: 'utf8',
            windowsHide: true
        });
        assert.equal(symlinkBlob.status, 0, symlinkBlob.stderr);
        runGit(repoRoot, [
            'update-index',
            '--add',
            '--cacheinfo',
            `120000,${String(symlinkBlob.stdout || '').trim()},${symlinkPath}`
        ]);
        const symlinkPreflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_staged_only',
            changed_files: ['src/app.ts', symlinkPath],
            metrics: { changed_lines_total: 4 }
        }, `${taskId}-symlink-preflight.json`);
        const symlinkPreflight = JSON.parse(fs.readFileSync(symlinkPreflightPath, 'utf8')) as Record<string, unknown>;
        const symlinkCodeScope = computeReviewReuseCodeScopeFingerprint('code', symlinkPreflight, repoRoot);

        assert.deepEqual(symlinkCodeScope.review_reuse_neutral_evidence_files, []);
        assert.equal(symlinkCodeScope.non_test_changed_files.includes(symlinkPath), true);
        assert.notEqual(symlinkCodeScope.code_scope_sha256, priorCodeScope.code_scope_sha256);

        const escapedTailPath = `garda-agent-orchestrator/runtime/manual-validation/${taskId}/nested/../escaped.log`;
        fs.writeFileSync(path.join(repoRoot, escapedTailPath), 'BUILD SUCCESSFUL\n', 'utf8');
        const escapedTailPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', escapedTailPath],
            metrics: { changed_lines_total: 4 }
        }, `${taskId}-escaped-tail-preflight.json`);
        const escapedTailPreflight = JSON.parse(
            fs.readFileSync(escapedTailPreflightPath, 'utf8')
        ) as Record<string, unknown>;
        const escapedTailCodeScope = computeReviewReuseCodeScopeFingerprint('code', escapedTailPreflight, repoRoot);

        assert.deepEqual(escapedTailCodeScope.review_reuse_neutral_evidence_files, []);
        assert.equal(escapedTailCodeScope.non_test_changed_files.includes(escapedTailPath), true);
        assert.notEqual(escapedTailCodeScope.code_scope_sha256, priorCodeScope.code_scope_sha256);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps review-cycle policy workflow config changes in review reuse fingerprints', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-workflow-policy-no-reuse';
        const workflowConfigPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );
        const workflowConfigRelativePath = 'garda-agent-orchestrator/live/config/workflow-config.json';
        initializeGitRepo(repoRoot);

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 }
        }, `${taskId}-prior-preflight.json`);
        const priorPreflight = JSON.parse(fs.readFileSync(priorPreflightPath, 'utf8')) as Record<string, unknown>;
        const priorCodeScopeSha256 = computeReviewReuseCodeScopeFingerprint(
            'code',
            priorPreflight,
            repoRoot
        ).code_scope_sha256;
        const workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8')) as Record<string, any>;
        workflowConfig.review_cycle_guard.excluded_review_types = ['security'];
        fs.writeFileSync(workflowConfigPath, JSON.stringify(workflowConfig, null, 2) + '\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', workflowConfigRelativePath],
            metrics: { changed_lines_total: 5 },
            triggers: { changed_workflow_config_files: [workflowConfigRelativePath] }
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot);
        const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight, repoRoot);

        assert.deepEqual(codeScopeFingerprint.review_reuse_neutral_config_files, []);
        assert.deepEqual(reviewScopeFingerprint.review_reuse_neutral_config_files, []);
        assert.equal(codeScopeFingerprint.non_test_changed_files.includes(workflowConfigRelativePath), true);
        assert.equal(reviewScopeFingerprint.review_relevant_changed_files.includes(workflowConfigRelativePath), true);
        assert.notEqual(codeScopeFingerprint.code_scope_sha256, priorCodeScopeSha256);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence when non-runtime performance support is delegated to performance review', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-code-reuse-performance-support';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code review when only benchmark support changes'
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
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const benchmark = "alpha";\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'benchmark/reviewed.ts'],
            metrics: { changed_lines_total: 4 },
            triggers: { performance: true },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: true,
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
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(codeBuild.outputLines.some((line) => line.includes('non-runtime performance support file(s) delegated')));

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(
            refreshedReceipt.code_scope_sha256,
            computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot).code_scope_sha256
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
