import {
    describe,
    it,
    assert,
    fs,
    path,
    runBuildReviewContextCommand,
    computeReviewRelevantScopeFingerprint,
    createTempRepo,
    findLastTimelineEventIndex,
    getReviewsRoot,
    initializeGitRepo,
    readTaskTimelineEvents,
    runEnterTaskMode,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeCompilePassEvidence,
    writePreflight,
    writeScopedDiffPathsConfig,
    buildScopedDiffFixture
} from './gates-review-reuse-fixtures';

describe('cli/commands/gates - review reuse downstream reuse', () => {
    it('reuses matching historical test-review evidence when the latest mutable receipt was overwritten by polluted scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-historical-test-reuse-after-receipt-overwrite';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse historical test review evidence after mutable receipt overwrite'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: false,
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:test-reviewer');

        const receiptPath = path.join(reviewsRoot, `${taskId}-test-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        const overwrittenReceipt = {
            ...originalReceipt,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        };
        assert.notEqual(overwrittenReceipt.review_scope_sha256, originalReceipt.review_scope_sha256);
        fs.writeFileSync(receiptPath, JSON.stringify(overwrittenReceipt, null, 2) + '\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: false,
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

        const result = await runBuildReviewContextCommand({
            reviewType: 'test',
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
        assert.equal(refreshedReceipt.reused_from_review_scope_sha256, originalReceipt.review_scope_sha256);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior test-review evidence when a test file changes after the review', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-test-change-no-test-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse test review evidence after test file changes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
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
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, testReviewContextPath, 'agent:test-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works after change", () => {});\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'code',
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
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

        const testBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'test',
            depth: 2,
            preflightPath,
            outputPath: testReviewContextPath
        });
        assert.equal(testBuild.reusedReviewEvidence, false);

        const testContext = JSON.parse(fs.readFileSync(testReviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = testContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses non-test review evidence when only tests change after domain reviews with full-diff fallback contexts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-domain-reuse-after-test-delta';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const pathsConfigPath = writeScopedDiffPathsConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 5;\nconst b = 7;\nconsole.log(a + b);\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse non-test reviews when a later delta only changes tests'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: true,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const securityReviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        const refactorReviewContextPath = path.join(reviewsRoot, `${taskId}-refactor-review-context.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        buildScopedDiffFixture(repoRoot, taskId, 'security', priorPreflightPath, pathsConfigPath);
        buildScopedDiffFixture(repoRoot, taskId, 'refactor', priorPreflightPath, pathsConfigPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'security', 'SECURITY REVIEW PASSED', priorPreflightPath, securityReviewContextPath, 'agent:security-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'refactor', 'REFACTOR REVIEW PASSED', priorPreflightPath, refactorReviewContextPath, 'agent:refactor-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, testReviewContextPath, 'agent:test-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works after the test-only delta", () => {});\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'code',
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: true,
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

        buildScopedDiffFixture(repoRoot, taskId, 'security', preflightPath, pathsConfigPath);
        const securityBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'security',
            depth: 2,
            preflightPath,
            outputPath: securityReviewContextPath
        });
        assert.equal(securityBuild.reusedReviewEvidence, true);
        assert.ok(securityBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(securityBuild.outputLines.some((line) => line.includes('only test files changed after accepted code scope')));

        buildScopedDiffFixture(repoRoot, taskId, 'refactor', preflightPath, pathsConfigPath);
        const refactorBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'refactor',
            depth: 2,
            preflightPath,
            outputPath: refactorReviewContextPath
        });
        assert.equal(refactorBuild.reusedReviewEvidence, true);
        assert.ok(refactorBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(refactorBuild.outputLines.some((line) => line.includes('only test files changed after accepted code scope')));

        const testBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'test',
            depth: 2,
            preflightPath,
            outputPath: testReviewContextPath
        });
        assert.equal(testBuild.reusedReviewEvidence, false);
        assert.ok(testBuild.outputLines.includes('ReviewReuseDecision: rejected'));
        assert.ok(testBuild.outputLines.some((line) => line.includes('review-relevant scope changed')));

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentRecordedEvents = events.slice(latestCompileSequence + 1).filter((event) => event.event_type === 'REVIEW_RECORDED');
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
                && (event.details as Record<string, unknown> | undefined)?.reused_existing_review === true
            )),
            true
        );
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'security'
                && (event.details as Record<string, unknown> | undefined)?.reused_existing_review === true
            )),
            true
        );
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'refactor'
                && (event.details as Record<string, unknown> | undefined)?.reused_existing_review === true
            )),
            true
        );
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
            )),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses upstream code and domain review evidence when a new regression test is added after source review', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-domain-reuse-after-new-test-delta';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const pathsConfigPath = writeScopedDiffPathsConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 5;\nconst b = 7;\nconsole.log(a + b);\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse upstream reviews when a later delta adds a regression test'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: true,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const securityReviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        const refactorReviewContextPath = path.join(reviewsRoot, `${taskId}-refactor-review-context.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        buildScopedDiffFixture(repoRoot, taskId, 'security', priorPreflightPath, pathsConfigPath);
        buildScopedDiffFixture(repoRoot, taskId, 'refactor', priorPreflightPath, pathsConfigPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'security', 'SECURITY REVIEW PASSED', priorPreflightPath, securityReviewContextPath, 'agent:security-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'refactor', 'REFACTOR REVIEW PASSED', priorPreflightPath, refactorReviewContextPath, 'agent:refactor-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, testReviewContextPath, 'agent:test-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'tests', 'regression.test.ts'), 'it("covers regression", () => {});\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'code',
            changed_files: ['src/app.ts', 'tests/regression.test.ts'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: true,
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

        buildScopedDiffFixture(repoRoot, taskId, 'security', preflightPath, pathsConfigPath);
        const securityBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'security',
            depth: 2,
            preflightPath,
            outputPath: securityReviewContextPath
        });
        assert.equal(securityBuild.reusedReviewEvidence, true);
        assert.ok(securityBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(securityBuild.outputLines.some((line) => line.includes('only test files changed after accepted code scope')));
        assert.ok(securityBuild.outputLines.some((line) => line.includes('review context changed only by test delta')));

        buildScopedDiffFixture(repoRoot, taskId, 'refactor', preflightPath, pathsConfigPath);
        const refactorBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'refactor',
            depth: 2,
            preflightPath,
            outputPath: refactorReviewContextPath
        });
        assert.equal(refactorBuild.reusedReviewEvidence, true);
        assert.ok(refactorBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(refactorBuild.outputLines.some((line) => line.includes('only test files changed after accepted code scope')));
        assert.ok(refactorBuild.outputLines.some((line) => line.includes('review context changed only by test delta')));

        const testBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'test',
            depth: 2,
            preflightPath,
            outputPath: testReviewContextPath
        });
        assert.equal(testBuild.reusedReviewEvidence, false);
        assert.ok(testBuild.outputLines.includes('ReviewReuseDecision: rejected'));
        assert.ok(testBuild.outputLines.some((line) => line.includes('review-relevant scope changed')));

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentRecordedEvents = events.slice(latestCompileSequence + 1).filter((event) => event.event_type === 'REVIEW_RECORDED');
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
                && (event.details as Record<string, unknown> | undefined)?.reused_existing_review === true
            )),
            true
        );
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'security'
                && (event.details as Record<string, unknown> | undefined)?.reused_existing_review === true
            )),
            true
        );
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'refactor'
                && (event.details as Record<string, unknown> | undefined)?.reused_existing_review === true
            )),
            true
        );
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
            )),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse non-test review evidence for sensitive test-path deltas', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-domain-reuse-sensitive-test-delta';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const pathsConfigPath = writeScopedDiffPathsConfig(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 5;\nconst b = 7;\nconsole.log(a + b);\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse domain reviews for sensitive test-path deltas'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: true,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const refactorReviewContextPath = path.join(reviewsRoot, `${taskId}-refactor-review-context.json`);
        buildScopedDiffFixture(repoRoot, taskId, 'refactor', priorPreflightPath, pathsConfigPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'refactor', 'REFACTOR REVIEW PASSED', priorPreflightPath, refactorReviewContextPath, 'agent:refactor-reviewer');

        fs.mkdirSync(path.join(repoRoot, 'tests', 'config'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'config', 'app.test.ts'), 'it("covers config behavior", () => {});\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'code',
            changed_files: ['src/app.ts', 'tests/config/app.test.ts'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: true,
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

        buildScopedDiffFixture(repoRoot, taskId, 'refactor', preflightPath, pathsConfigPath);
        const refactorBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'refactor',
            depth: 2,
            preflightPath,
            outputPath: refactorReviewContextPath
        });
        assert.equal(refactorBuild.reusedReviewEvidence, false);
        assert.ok(refactorBuild.outputLines.includes('ReviewReuseDecision: rejected'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse legacy non-test review evidence through a newer peer code receipt after code changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-legacy-domain-reuse-after-code-change';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse legacy domain review evidence after code changes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const securityReviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:old-code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'security', 'SECURITY REVIEW PASSED', priorPreflightPath, securityReviewContextPath, 'agent:security-reviewer');

        const securityReceiptPath = path.join(reviewsRoot, `${taskId}-security-receipt.json`);
        const securityReceipt = JSON.parse(fs.readFileSync(securityReceiptPath, 'utf8')) as Record<string, unknown>;
        securityReceipt.code_scope_sha256 = null;
        fs.writeFileSync(securityReceiptPath, JSON.stringify(securityReceipt, null, 2) + '\n', 'utf8');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 10;\nconst b = 20;\nconsole.log(a + b);\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, codeReviewContextPath, 'agent:new-code-reviewer');

        const securityBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'security',
            depth: 2,
            preflightPath,
            outputPath: securityReviewContextPath
        });
        assert.equal(securityBuild.reusedReviewEvidence, false);

        const securityContext = JSON.parse(fs.readFileSync(securityReviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = securityContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentSecurityRecordedEvents = events.slice(latestCompileSequence + 1).filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'security'
        ));
        assert.equal(currentSecurityRecordedEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse legacy non-test review evidence through a same-preflight peer code receipt after code changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-same-preflight-legacy-domain-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse legacy domain review evidence through same-preflight peer code scope'
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const securityReviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, codeReviewContextPath, 'agent:old-code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'security', 'SECURITY REVIEW PASSED', preflightPath, securityReviewContextPath, 'agent:security-reviewer');

        const securityReceiptPath = path.join(reviewsRoot, `${taskId}-security-receipt.json`);
        const securityReceipt = JSON.parse(fs.readFileSync(securityReceiptPath, 'utf8')) as Record<string, unknown>;
        securityReceipt.code_scope_sha256 = null;
        fs.writeFileSync(securityReceiptPath, JSON.stringify(securityReceipt, null, 2) + '\n', 'utf8');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 10;\nconst b = 20;\nconsole.log(a + b);\n', 'utf8');
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, codeReviewContextPath, 'agent:new-code-reviewer');

        const securityBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'security',
            depth: 2,
            preflightPath,
            outputPath: securityReviewContextPath
        });
        assert.equal(securityBuild.reusedReviewEvidence, false);

        const securityContext = JSON.parse(fs.readFileSync(securityReviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = securityContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentSecurityRecordedEvents = events.slice(latestCompileSequence + 1).filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'security'
        ));
        assert.equal(currentSecurityRecordedEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
