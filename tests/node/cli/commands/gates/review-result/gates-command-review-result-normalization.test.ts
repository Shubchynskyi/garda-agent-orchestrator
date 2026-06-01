import {
    describe,
    it,
    assert,
    fs,
    path,
    runCliMainWithHandling,
    createTempRepo,
    seedTaskQueue,
    seedInitAnswers,
    getReviewsRoot,
    getOrchestratorRoot,
    createReviewerRoutingFixture,
    writePreflight,
    prepareCurrentReviewPhase,
    readTaskTimelineEvents,
    runCliWithCapturedOutput,
    manualReviewContextTaskScopeFixture,
    manualReviewContextBindingFixture,
    reviewContextScopedDiffFixture,
    recordReviewRoutingViaCli,
    attestReviewerInvocationForTest,
    seedPromptBoundReviewFixture
} from './gates-command-review-result-fixtures';

describe('gates command review result - normalization', () => {

    it('record-review-result normalizes obvious reviewer section heading variants while preserving raw output', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-318-heading-normalization';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputContent = [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers/index.ts` and `src/gates/completion-verdict-markdown.ts` for reviewer receipt heading normalization, confirming that obvious markdown variants remain auditable without changing raw evidence.',
            '',
            '**Findings by Severity**',
            'none',
            '',
            '### Residual Risks',
            'none',
            '',
            '## **Verdict**',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(reviewOutputPath, reviewOutputContent, 'utf8');

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
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, reviewOutputContent);
        assert.ok(rawReviewContent.includes('**Findings by Severity**'));
        assert.ok(rawReviewContent.includes('### Residual Risks'));
        assert.ok(rawReviewContent.includes('## **Verdict**'));
        assert.ok(artifactContent.includes('## Findings by Severity\nnone'));
        assert.ok(artifactContent.includes('## Residual Risks\nnone'));
        assert.ok(artifactContent.includes('## Verdict\nREVIEW PASSED'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result does not convert PASS validation-boundary notes into deferred findings', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-496-validation-boundary-notes';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputContent = [
            '# Review',
            '',
            'Reviewed `src/cli/commands/gate-review-handlers/index.ts` and `src/gates/build-review-context.ts` for PASS review normalization. I did not identify a blocking lifecycle, routing, review-trust, or test-adequacy regression.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            '- Full repository test suite was not run by this reviewer. Focused validation passed: `npm test -- tests/node/gates/build-review-context.test.ts`.',
            '- Read-only review; full-suite validation was already covered by the mandatory gate.',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(reviewOutputPath, reviewOutputContent, 'utf8');

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
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, reviewOutputContent);
        assert.ok(artifactContent.includes('## Preserved Raw Reviewer Output'));
        assert.ok(artifactContent.includes('## Findings by Severity\nnone'));
        assert.ok(artifactContent.includes('## Deferred Findings\n\nnone'));
        assert.ok(artifactContent.includes('## Residual Risks\nnone'));
        assert.ok(artifactContent.includes('## Verdict\nREVIEW PASSED'));
        assert.ok(!artifactContent.includes('- [follow-up] Full repository test suite was not run by this reviewer'));
        assert.ok(!artifactContent.includes('- [follow-up] Read-only review; full-suite validation was already covered'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result filters inline-diff validation-boundary notes from PASS residual risks', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-575-inline-diff-boundary-note';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputContent = [
            '# Review',
            '',
            'Reviewed `src/cli/commands/gate-review-handlers/index.ts` and `src/gates/completion-verdict-findings.ts` for PASS review boundary-note handling. I confirmed the reviewer-output parser keeps non-actionable validation limits out of strict follow-up sections.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            '- Review artifact did not include inline diff; reviewer relied on the generated review context and source inspection for `src/cli/commands/gate-review-handlers/index.ts`.',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(reviewOutputPath, reviewOutputContent, 'utf8');

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
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, reviewOutputContent);
        assert.ok(artifactContent.includes('## Preserved Raw Reviewer Output'));
        assert.ok(artifactContent.includes('Review artifact did not include inline diff'));
        assert.ok(artifactContent.includes('## Findings by Severity\nnone'));
        assert.ok(artifactContent.includes('## Deferred Findings\n\nnone'));
        assert.ok(artifactContent.includes('## Residual Risks\nnone'));
        const normalizedDeferredStart = artifactContent.lastIndexOf('## Deferred Findings');
        const normalizedDeferredBlock = normalizedDeferredStart >= 0
            ? artifactContent.slice(normalizedDeferredStart).split('## Residual Risks')[0] || ''
            : '';
        assert.ok(!normalizedDeferredBlock.includes('Review artifact did not include inline diff'));
        const normalizedResidualStart = artifactContent.lastIndexOf('## Residual Risks');
        const normalizedResidualBlock = normalizedResidualStart >= 0
            ? artifactContent.slice(normalizedResidualStart).split('## Verdict')[0] || ''
            : '';
        assert.ok(!normalizedResidualBlock.includes('Review artifact did not include inline diff'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result filters command log notes from PASS deferred follow-up obligations', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-545-command-log-notes';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputContent = [
            '# Review',
            '',
            'Reviewed `src/cli/commands/gate-review-handlers/index.ts` and `src/gates/build-review-context.ts` for reviewer output normalization.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none.',
            '',
            'Commands run:',
            '- `Get-Content TASK.md -TotalCount 260`',
            '- `rg -n "Deferred Findings|Commands run" src/cli/commands/gate-review-handlers/index.ts`',
            '- `npm test -- tests/node/cli/commands/gates.test.ts`',
            '',
            '## Deferred Findings',
            'none.',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(reviewOutputPath, reviewOutputContent, 'utf8');

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
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, reviewOutputContent);
        assert.ok(artifactContent.includes('## Preserved Raw Reviewer Output'));
        assert.ok(artifactContent.includes('## Findings by Severity\nnone'));
        assert.ok(artifactContent.includes('## Deferred Findings\n\nnone'));
        assert.ok(artifactContent.includes('## Residual Risks\nnone'));
        assert.ok(artifactContent.includes('## Verdict\nREVIEW PASSED'));
        const normalizedDeferredStart = artifactContent.lastIndexOf('## Deferred Findings');
        const normalizedDeferredBlock = normalizedDeferredStart >= 0
            ? artifactContent.slice(normalizedDeferredStart).split('## Residual Risks')[0] || ''
            : '';
        assert.ok(!normalizedDeferredBlock.includes('Commands run:'));
        assert.ok(!normalizedDeferredBlock.includes('Get-Content TASK.md'));
        assert.ok(!normalizedDeferredBlock.includes('rg -n'));
        assert.ok(!normalizedDeferredBlock.includes('npm test -- tests/node/cli/commands/gates.test.ts'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result deduplicates PASS deferred findings before strict follow-up enforcement', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-545-dedup-deferred';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-refactor.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-refactor-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'refactor'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'refactor'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'refactor');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Refactor Review',
            '',
            'Reviewed `src/cli/commands/gate-review-handlers/index.ts` for duplicate deferred finding handling.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            '- Add focused coverage for reviewer command-log normalization.',
            '  Justification: Keep one canonical structured follow-up obligation.',
            '- Add focused coverage for reviewer command-log normalization.',
            '  Justification: Keep one canonical structured follow-up obligation.',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REFACTOR REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'refactor',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:refactor-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'refactor',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:refactor-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const normalizedDeferredStart = artifactContent.lastIndexOf('## Deferred Findings');
        const normalizedDeferredBlock = normalizedDeferredStart >= 0
            ? artifactContent.slice(normalizedDeferredStart).split('## Residual Risks')[0] || ''
            : '';
        assert.equal(
            (normalizedDeferredBlock.match(/Add focused coverage for reviewer command-log normalization\./g) || []).length,
            1
        );
        assert.ok(normalizedDeferredBlock.includes('Justification: Keep one canonical structured follow-up obligation.'));
        assert.ok(!normalizedDeferredBlock.includes('Justification: Preserved from raw reviewer output during PASS review normalization.'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects command-like active findings in PASS output instead of inferring follow-ups', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-545-command-like-finding';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-security.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'security'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'security'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'security');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Security Review',
            '',
            'Reviewed reviewer output normalization for command-like active findings.',
            '',
            '## Findings by Severity',
            '- High: npm install can pull attacker-controlled packages when reviewer output parsing trusts command-looking findings as validation notes.',
            '',
            '## Deferred Findings',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'SECURITY REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await recordReviewRoutingViaCli({
                taskId,
                reviewType: 'security',
                repoRoot,
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:security-reviewer'
            });
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'security',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:security-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects command-prefixed risk signals in command blocks instead of inferring follow-ups', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-545-command-risk-signal';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Code Review',
            '',
            'Reviewed command-block preservation for security-relevant validation output.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            'Commands run:',
            '- `npm audit found vulnerabilities in reviewer output materialization`',
            '- `npm audit reported advisory CVE-2026-0001 RCE XSS credential secret token injection traversal`',
            '',
            '## Deferred Findings',
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
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result does not convert T-547-2 PASS residual-risk noise into deferred findings', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-547-2-residual-risk-noise';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputContent = [
            '# Review',
            '',
            'Validated PASS review normalization for ordinary reviewer summaries.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            '- I could not execute the touched tests directly with `node --test` because this repo\'s test files are TypeScript ESM and require the project\'s normal test harness/runner; direct invocation fails at module loading.',
            '- Based on code inspection, enforcement is correctly wired for mutating `workflow set` paths and coverage was added for missing, missing-timestamp, and stale timestamp cases.',
            '- Time-based tests rely on wall-clock `new Date().toISOString()` and could be sensitive to extreme clock skew in unusual environments, but this is a low residual risk and the suite passed in current preflight.',
            '- Reviewed `src/gates/next-step.ts`, `tests/node/gates/next-step.test.ts`, and `CHANGELOG.md`. I did not identify a blocking lifecycle, routing, review-trust, or test-adequacy regression.',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.writeFileSync(reviewOutputPath, reviewOutputContent, 'utf8');

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
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        const rawReviewContent = fs.readFileSync(rawReviewOutputPath, 'utf8');
        assert.equal(rawReviewContent, reviewOutputContent);
        assert.ok(artifactContent.includes('## Preserved Raw Reviewer Output'));
        assert.ok(artifactContent.includes('## Findings by Severity\nnone'));
        assert.ok(artifactContent.includes('## Deferred Findings\n\nnone'));
        assert.ok(artifactContent.includes('## Residual Risks\nnone'));
        assert.ok(artifactContent.includes('## Verdict\nREVIEW PASSED'));
        assert.ok(!artifactContent.includes('- [follow-up] I could not execute the touched tests directly'));
        assert.ok(!artifactContent.includes('- [follow-up] Based on code inspection'));
        assert.ok(!artifactContent.includes('- [follow-up] Time-based tests rely on wall-clock'));
        assert.ok(!artifactContent.includes('- [follow-up] Reviewed `src/gates/next-step.ts`'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');
        assert.equal(receipt.review_output_path, rawReviewOutputPath.replace(/\\/g, '/'));
        assert.notEqual(receipt.review_artifact_sha256, receipt.review_output_sha256);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewMaterializationFidelity: normalized_lossless')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result still preserves actionable PASS follow-ups as deferred findings', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-496-actionable-followup';
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

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Reviewed `src/cli/commands/gate-review-handlers/index.ts` for PASS review normalization and confirmed the artifact remains auditable after preserving explicit structured deferred findings.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            '- Add explicit future-skew regression coverage for workflow set operator timestamps.',
            '  Justification: The main task covered missing and stale timestamp paths; future-skew workflow-specific coverage can be tracked as separate hardening.',
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
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        const artifactContent = fs.readFileSync(artifactPath, 'utf8');
        assert.ok(artifactContent.includes('## Deferred Findings'));
        assert.ok(artifactContent.includes('- Add explicit future-skew regression coverage for workflow set operator timestamps. Justification: The main task covered missing and stale timestamp paths; future-skew workflow-specific coverage can be tracked as separate hardening.'));
        assert.ok(!artifactContent.includes('Justification: Preserved from raw reviewer output during PASS review normalization.'));
        assert.ok(artifactContent.includes('## Residual Risks\nnone'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.review_materialization_fidelity, 'normalized_lossless');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result materializes no-findings PASS output with substantive validation notes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-validation-notes-pass';
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
            '## Validation Notes',
            'Reviewed `src/app.ts`, the prompt-bound review context, delegated invocation telemetry, and no-findings PASS materialization path. The implementation behavior, review boundaries, and receipt persistence were checked against the generated output template.',
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

        assert.equal(result.exitCode, 0, result.errors.join('\n'));
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), true);
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), true);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects headings-only PASS output with empty validation notes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-validation-notes-empty';
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
            '## Validation Notes',
            'none',
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
        assert.ok(result.errors.some((line) => line.includes('empty or non-substantive PASS validation notes')), result.errors.join('\n'));
        const errorText = result.errors.join('\n');
        assert.ok(errorText.includes("Exact accepted PASS verdict token for 'code': REVIEW PASSED"));
        assert.ok(errorText.includes('# Code Review'));
        assert.ok(errorText.includes('## Validation Notes'));
        assert.ok(errorText.includes('## Findings by Severity'));
        assert.ok(errorText.includes('## Deferred Findings'));
        assert.ok(errorText.includes('## Residual Risks'));
        assert.ok(errorText.includes('## Verdict'));
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), false);
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result fails closed when bound output template is stale before PASS notes policy resolution', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-validation-notes-template-stale';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        fs.writeFileSync(fixture.outputTemplatePath, '# tampered output template\n', 'utf8');
        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
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
        assert.ok(result.errors.some((line) => line.includes('reviewer output template artifact is stale')), result.errors.join('\n'));
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), false);
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result fails closed when output template binding is missing before PASS notes policy resolution', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-validation-notes-template-missing';
        const fixture = await seedPromptBoundReviewFixture({ repoRoot, taskId });
        attestReviewerInvocationForTest({
            repoRoot,
            taskId,
            reviewType: 'code',
            reviewContextPath: fixture.reviewContextPath,
            reviewerIdentity: fixture.reviewerIdentity
        });
        const reviewContext = JSON.parse(fs.readFileSync(fixture.reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerHandoff = reviewContext.reviewer_handoff as Record<string, unknown>;
        delete reviewerHandoff.output_template;
        fs.writeFileSync(fixture.reviewContextPath, `${JSON.stringify(reviewContext, null, 2)}\n`, 'utf8');
        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, 'code');
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        const reviewOutputPath = path.join(reviewOutputDir, 'review-output.md');
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
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
        assert.ok(result.errors.some((line) => line.includes('reviewer_handoff.output_template.artifact_path')), result.errors.join('\n'));
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code.md`)), false);
        assert.equal(fs.existsSync(path.join(fixture.reviewsRoot, `${taskId}-code-receipt.json`)), false);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result keeps trivial pass review blocked when lossless normalization would otherwise add deferred follow-up', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-trivial-pass-findings';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# R',
            '',
            'x',
            '',
            '## Findings by Severity',
            '- High: x',
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
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
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
        assert.equal(fs.existsSync(rawReviewOutputPath), false);
        assert.ok(capturedErrors.some((line) => line.includes('trivial or obviously synthetic')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects PASS output with active findings and residual risks instead of inferring follow-ups', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-pass-findings';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
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
            'Validated the materialization guard against a pass artifact that still reports active follow-up while preserving the reviewer evidence losslessly.',
            '',
            '## Findings by Severity',
            '- High: `src/app.ts:1` this reviewer intentionally kept an unresolved blocker while claiming a pass verdict.',
            '',
            '## Residual Risks',
            '- Confirm the follow-up stays visible to operators after pass-review normalization.',
            '',
            '## Verdict',
            'REVIEW PASSED',
            '',
            '## Additional Reviewer Notes',
            'The unresolved blocker stays intentionally visible in the raw review output for audit provenance.'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
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

        assert.notEqual(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), false);
        const rawReviewContent = fs.readFileSync(reviewOutputPath, 'utf8');
        assert.ok(rawReviewContent.includes('still reports active follow-up while preserving the reviewer evidence losslessly.'));
        assert.ok(rawReviewContent.includes('## Findings by Severity'));
        assert.ok(rawReviewContent.includes('## Residual Risks\n- Confirm the follow-up stays visible to operators after pass-review normalization.'));
        assert.ok(rawReviewContent.includes('## Additional Reviewer Notes'));
        assert.ok(capturedErrors.some((line) => line.includes('still contains active High findings')));
        assert.ok(capturedErrors.some((line) => line.includes('still contains active residual risks')));
        assert.ok(capturedErrors.some((line) => line.includes('Only real accepted actionable follow-ups belong')));
        assert.equal(capturedErrors.some((line) => line.includes('Move accepted non-blocking follow-up')), false);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects no-findings PASS output when deferred findings lack justification', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-pass-no-findings-recovery';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
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
            'Validated the no-findings pass-review materialization path with concrete scope notes and enough detail to stay above the trivial-review threshold while still keeping the artifact intentionally malformed for recovery guidance.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            '- [low] follow up on reviewer wording in `src/cli/commands/gate-review-handlers.ts:1`',
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
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
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

        assert.notEqual(observedExitCode, 0);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), false);
        const rawReviewContent = fs.readFileSync(reviewOutputPath, 'utf8');
        assert.ok(rawReviewContent.includes('## Deferred Findings'));
        assert.ok(rawReviewContent.includes('- [low] follow up on reviewer wording'));
        assert.ok(!rawReviewContent.includes('Justification:'));
        assert.ok(capturedErrors.some((line) => line.includes("deferred finding without usable 'Justification:'")));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects ambiguous duplicate reviewer section headings', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-318-duplicate-heading';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            ...manualReviewContextBindingFixture(repoRoot, taskId, 'code'),
            task_scope: manualReviewContextTaskScopeFixture(repoRoot, taskId),
            scoped_diff: reviewContextScopedDiffFixture(repoRoot, taskId, 'code'),
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/gates/completion-verdict-markdown.ts` and duplicate section handling with enough concrete detail to avoid the triviality filter while keeping the duplicate heading malformed on purpose.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '**Findings by Severity**',
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
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
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
        assert.equal(fs.existsSync(rawReviewOutputPath), false);
        assert.ok(capturedErrors.some((line) => line.includes("ambiguous duplicate section heading for '## Findings by Severity'")));
        assert.ok(capturedErrors.some((line) => line.includes("Accepted section heading shapes include '## Findings by Severity'")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
