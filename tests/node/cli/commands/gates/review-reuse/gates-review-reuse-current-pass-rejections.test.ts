import {
    describe,
    it,
    assert,
    fs,
    path,
    runBuildReviewContextCommand,
    appendTaskEvent,
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    runEnterTaskMode,
    seedInitAnswers,
    seedReusableReviewEvidence,
    seedTaskQueue,
    writeCompilePassEvidence,
    writePreflight,
    getReviewTreeStateSha256FromFixtureContext} from './gates-review-reuse-fixtures';
import {
    tryAcceptCurrentPassReviewEvidence
} from '../../../../../../src/cli/commands/gate-flows/review-context/review-context-flow-current-pass-reuse';

describe('cli/commands/gates - current-cycle review reuse rejections', () => {
    it('rebuilds current-cycle fresh PASS context when review-recorded telemetry lacks integrity', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-untrusted-recorded';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when REVIEW_RECORDED telemetry is untrusted'
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
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const timelineLines = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0);
        const tamperedLines = timelineLines.map((line) => {
            const event = JSON.parse(line) as Record<string, unknown>;
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : {};
            if (
                event.event_type === 'REVIEW_RECORDED'
                && String(details.review_type || details.reviewType || '').trim().toLowerCase() === 'code'
            ) {
                delete event.integrity;
            }
            return JSON.stringify(event);
        });
        fs.writeFileSync(timelinePath, tamperedLines.join('\n') + '\n', 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('trusted current-cycle REVIEW_RECORDED telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle fresh PASS context when the review context JSON is corrupt', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-corrupt-context';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when review context JSON is corrupt'
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
        fs.writeFileSync(reviewContextPath, '{not-json', 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('existing review context is missing or corrupt')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle fresh PASS context when the receipt is no longer independently audited', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-untrusted-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when receipt trust level is downgraded'
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
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.trust_level = 'LOCAL_ASSERTED';
        fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('review receipt bindings do not match')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle fresh PASS context when reviewer invocation provenance is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-missing-provenance';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when reviewer invocation provenance is missing'
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
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.reviewer_provenance = null;
        fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('reviewer invocation attestation')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle PASS review context when the handoff artifact is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-missing-handoff';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when the handoff artifact is missing'
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
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const ruleContext = reviewContext.rule_context as Record<string, unknown>;
        const ruleContextArtifactPath = String(ruleContext.artifact_path || '');
        assert.ok(ruleContextArtifactPath);
        fs.rmSync(ruleContextArtifactPath, { force: true });

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('readable reviewer prompt artifact')));
        assert.equal(fs.existsSync(ruleContextArtifactPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle PASS review context when the reviewer-visible tree-state is stale', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-stale-tree-state';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when reviewer-visible tree state changes'
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
        const originalContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const originalTreeStateSha256 = getReviewTreeStateSha256FromFixtureContext(originalContext);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changedAfterPass = true;\n', 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('review context tree_state is stale')));
        const rebuiltContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        assert.notEqual(getReviewTreeStateSha256FromFixtureContext(rebuiltContext), originalTreeStateSha256);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle reused PASS context when hidden timing trust distrusts the attested reviewer timing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-915-current-pass-hidden-timing-distrust';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current reused PASS evidence when hidden timing trust distrusts the attested reviewer timing'
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

        const firstBuild = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });
        assert.equal(firstBuild.reusedReviewEvidence, true, firstBuild.outputLines.join('\n'));

        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const reviewerProvenance = receipt.reviewer_provenance as Record<string, unknown>;
        const timelineLines = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0);
        let updatedInvocationEvent = false;
        const tamperedTimeline = timelineLines.map((line) => {
            const event = JSON.parse(line) as Record<string, unknown>;
            const integrity = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
                ? event.integrity as Record<string, unknown>
                : null;
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : null;
            if (
                event.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                && integrity
                && details
                && Number(integrity.task_sequence) === Number(reviewerProvenance.task_sequence)
                && String(integrity.event_sha256 || '').trim().toLowerCase()
                    === String(reviewerProvenance.event_sha256 || '').trim().toLowerCase()
            ) {
                details.launch_prepared_at_utc = '2026-04-28T00:00:00.000Z';
                details.delegation_started_at_utc = '2026-04-28T00:00:01.000Z';
                details.launched_at_utc = '2026-04-28T00:00:01.000Z';
                details.launch_completed_at_utc = '2026-04-28T00:00:05.000Z';
                details.invocation_attested_at_utc = '2026-04-28T00:00:05.500Z';
                updatedInvocationEvent = true;
            }
            return JSON.stringify(event);
        });
        assert.equal(updatedInvocationEvent, true);
        fs.writeFileSync(timelinePath, `${tamperedTimeline.join('\n')}\n`, 'utf8');

        const secondCurrentPass = tryAcceptCurrentPassReviewEvidence({
            repoRoot,
            taskId,
            reviewType: 'code',
            preflightPath,
            preflightPayload: JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
            reviewContextPath
        });

        assert.equal(secondCurrentPass.accepted, false, JSON.stringify(secondCurrentPass, null, 2));
        const hiddenViolation = secondCurrentPass.reason;
        assert.match(hiddenViolation, /not sufficiently trustworthy/);
        assert.match(hiddenViolation, /Launch a real subagent using built-in tools/);
        assert.equal(
            /timing|threshold|elapsed|duration|seconds|too_short|impossible_ordering|missing_timing/i.test(hiddenViolation),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle reused PASS context when strict reuse telemetry is incomplete', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-untrusted-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when reused evidence telemetry is incomplete'
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
        await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        const crypto = require('node:crypto');
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const forgedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        delete forgedReceipt.reused_from_receipt_sha256;
        delete forgedReceipt.reused_from_review_context_sha256;
        delete forgedReceipt.reused_from_review_context_reuse_sha256;
        delete forgedReceipt.reused_from_review_tree_state_sha256;
        delete forgedReceipt.reused_from_review_scope_sha256;
        delete forgedReceipt.reused_from_code_scope_sha256;
        const forgedReceiptText = `${JSON.stringify(forgedReceipt, null, 2)}\n`;
        const forgedReceiptSha256 = crypto.createHash('sha256').update(forgedReceiptText).digest('hex');
        const forgedReceiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${forgedReceiptSha256}.json`);
        fs.writeFileSync(receiptPath, forgedReceiptText, 'utf8');
        fs.writeFileSync(forgedReceiptSnapshotPath, forgedReceiptText, 'utf8');
        const artifactText = fs.readFileSync(artifactPath, 'utf8');
        const artifactSha256 = crypto.createHash('sha256').update(artifactText).digest('hex');
        const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactSha256}.md`);
        fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'forged current reuse recorded', {
            ...forgedReceipt,
            reused_existing_review: true,
            receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
            receipt_sha256: forgedReceiptSha256,
            receipt_snapshot_path: path.normalize(forgedReceiptSnapshotPath).replace(/\\/g, '/'),
            receipt_snapshot_sha256: forgedReceiptSha256,
            review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
            review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
            review_artifact_snapshot_sha256: artifactSha256,
            review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/'),
            review_context_sha256: forgedReceipt.review_context_sha256
        });

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('strict reused evidence telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});