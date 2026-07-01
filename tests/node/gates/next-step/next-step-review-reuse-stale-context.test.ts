import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './next-step-review-reuse-fixtures';
const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    fileSha256,
    fs,
    makeTempRepo,
    markReviewEvidenceAsStrictReuse,
    path,
    resolveNextStep,
    reviewsRoot,
    seedCompilePass,
    seedPostPreflightRulePack,
    seedStartedTask,
    sha256Text,
    TASK_ID,
    writeJson,
    writePreflight,
    writeReviewContextOnly,
    writeReviewEvidence
} = fx;
void [assert];

function appendCurrentStrictReuseRecorded(repoRoot: string, taskId: string, reviewType: string): void {
    const root = reviewsRoot(repoRoot);
    const receiptPath = path.join(root, `${taskId}-${reviewType}-receipt.json`);
    const artifactPath = path.join(root, `${taskId}-${reviewType}.md`);
    const contextPath = path.join(root, `${taskId}-${reviewType}-review-context.json`);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    const receiptSha256 = fileSha256(receiptPath);
    const receiptSnapshotPath = path.join(root, `${taskId}-${reviewType}-receipt-${receiptSha256}.json`);
    const reviewArtifactSha256 = fileSha256(artifactPath);
    const reviewArtifactSnapshotPath = path.join(root, `${taskId}-${reviewType}-artifact-${reviewArtifactSha256}.md`);
    fs.copyFileSync(receiptPath, receiptSnapshotPath);
    fs.copyFileSync(artifactPath, reviewArtifactSnapshotPath);
    appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', {
        ...receipt,
        receipt_path: receiptPath,
        receipt_sha256: receiptSha256,
        receipt_snapshot_path: receiptSnapshotPath,
        receipt_snapshot_sha256: receiptSha256,
        review_artifact_path: artifactPath,
        review_artifact_sha256: reviewArtifactSha256,
        review_artifact_snapshot_path: reviewArtifactSnapshotPath,
        review_artifact_snapshot_sha256: reviewArtifactSha256,
        review_context_path: contextPath,
        review_context_sha256: fileSha256(contextPath),
        review_context_reuse_sha256: receipt.review_context_reuse_sha256,
        review_tree_state_sha256: receipt.review_tree_state_sha256,
        reused_existing_review: true
    });
}

describe('gates/next-step review reuse stale context routing', () => {
    it('refreshes review context after a failed upstream review becomes stale behind a new compile cycle', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'build-review-context');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Refresh 'code' review context/);
        assert.match(result.reason, /no longer current after the latest compile cycle/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('refreshes scoped diff before rebuilding a stale failed specialist review context', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, security: true });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.budget_forecast = {
            requested_depth: 2,
            effective_depth: 2,
            total_forecast_tokens: 1600,
            effective_forecast_tokens: 1200,
            token_economy_active_for_depth: true
        };
        preflight.risk_aware_depth = {
            compression: {
                scoped_diffs: true
            }
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'security', { verdict: 'fail' });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'build-scoped-diff');
        assert.equal(result.review.next_review_type, 'security');
        assert.match(result.title, /Prepare 'security' scoped diff metadata/);
        assert.ok(result.commands[0].command.includes('gate build-scoped-diff'));
        assert.ok(result.commands[0].command.includes('--review-type "security"'));
    });

    it('rebuilds stale failed downstream review after test-only remediation despite lane-domain match', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const testFile = path.join(repoRoot, 'tests', 'api-remediation.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("api remediation", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            refactor: true,
            api: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['tests/api-remediation.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'api', {
            verdict: 'fail',
            body: 'P1: API reviewer finding was fixed by a test-only remediation.\n\n'
        });

        fs.writeFileSync(testFile, 'test("api remediation", () => { assert.equal(1, 1); });\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            refactor: true,
            api: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['tests/api-remediation.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'api');
        assert.match(result.title, /Refresh 'api' review context/);
        assert.match(result.reason, /no longer current after the latest compile cycle/);
        assert.ok(result.commands[0].command.includes('--review-type "api"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.title.includes('Fix failed'));
    });

    it('rejects receipt-spoofed lane-domain freshness when review context evidence changed', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changedAfterReview = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const currentPreflight = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')
        ) as Record<string, unknown>;
        receipt.domain_scope_fingerprints = (currentPreflight.metrics as Record<string, unknown>).domain_scope_fingerprints;
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context');
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
        assert.ok(!result.review.launchable_review_types.includes('security'));
    });

    it('rebuilds each stale specialist review context against the current preflight hash', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        const oldPreflightPath = writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            db: true,
            security: true,
            refactor: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'db', reviewerIdentity);
        writeReviewContextOnly(repoRoot, TASK_ID, 'security', reviewerIdentity);
        writeReviewContextOnly(repoRoot, TASK_ID, 'refactor', reviewerIdentity);
        const oldPreflightSha256 = fileSha256(oldPreflightPath);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const specialistRefresh = 3;\n', 'utf8');
        const currentPreflightPath = writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            db: true,
            security: true,
            refactor: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        const currentPreflightSha256 = fileSha256(currentPreflightPath);

        const dbResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(dbResult.next_gate, 'build-review-context');
        assert.equal(dbResult.review.next_review_type, 'db');
        assert.ok(dbResult.reason.includes(`preflight_sha256=${oldPreflightSha256}`));
        assert.ok(dbResult.reason.includes(`preflight_sha256=${currentPreflightSha256}`));

        writeReviewEvidence(repoRoot, TASK_ID, 'db');
        const securityResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(securityResult.next_gate, 'build-review-context');
        assert.equal(securityResult.review.next_review_type, 'security');
        assert.ok(securityResult.reason.includes(`preflight_sha256=${oldPreflightSha256}`));
        assert.ok(securityResult.reason.includes(`preflight_sha256=${currentPreflightSha256}`));

        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        const refactorResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(refactorResult.next_gate, 'build-review-context');
        assert.equal(refactorResult.review.next_review_type, 'refactor');
        assert.ok(refactorResult.reason.includes(`preflight_sha256=${oldPreflightSha256}`));
        assert.ok(refactorResult.reason.includes(`preflight_sha256=${currentPreflightSha256}`));
    });

    it('blocks downstream review when current receipt provenance omits tree-state binding', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const provenance = receipt.reviewer_provenance as Record<string, unknown>;
        delete provenance.review_tree_state_sha256;
        receipt.reviewer_provenance = provenance;
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result');
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('reviewer_provenance is missing review_tree_state_sha256'));
    });

    it('blocks downstream review when current review context omits tree-state binding', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
        const treeState = context.tree_state as Record<string, unknown>;
        const originalTreeStateSha256 = String(treeState.tree_state_sha256 || '').trim();
        delete context.tree_state;
        const contextText = `${JSON.stringify(context, null, 2)}\n`;
        fs.writeFileSync(contextPath, contextText, 'utf8');

        const reviewerIdentity = 'agent:code-reviewer';
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const invocationIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: sha256Text(contextText),
            review_tree_state_sha256: originalTreeStateSha256,
            routing_event_sha256: routeIntegrity.event_sha256
        });
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.review_context_sha256 = sha256Text(contextText);
        receipt.review_tree_state_sha256 = originalTreeStateSha256;
        receipt.reviewer_provenance = {
            ...(receipt.reviewer_provenance as Record<string, unknown>),
            task_sequence: invocationIntegrity.task_sequence,
            prev_event_sha256: invocationIntegrity.prev_event_sha256,
            event_sha256: invocationIntegrity.event_sha256,
            review_context_sha256: sha256Text(contextText),
            review_tree_state_sha256: originalTreeStateSha256,
            routing_event_sha256: routeIntegrity.event_sha256
        };
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result');
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('review context is missing tree_state.tree_state_sha256'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('blocks downstream review when reused review telemetry omits tree-state reuse binding', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code.md`);
        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const reviewerProvenance = receipt.reviewer_provenance as Record<string, unknown>;
        const historicalTreeStateSha = '8'.repeat(64);
        receipt.reused_existing_review = true;
        receipt.reused_from_receipt_path = receiptPath;
        receipt.reused_from_review_context_sha256 = reviewerProvenance.review_context_sha256;
        receipt.reused_from_review_context_reuse_sha256 = '7'.repeat(64);
        receipt.reused_from_review_tree_state_sha256 = historicalTreeStateSha;
        receipt.reviewer_provenance = {
            ...reviewerProvenance,
            task_sequence: 1,
            prev_event_sha256: null,
            event_sha256: '9'.repeat(64),
            review_tree_state_sha256: historicalTreeStateSha
        };
        writeJson(receiptPath, receipt);
        const { reused_from_review_tree_state_sha256, ...receiptWithoutReuseTreeState } = receipt;
        void reused_from_review_tree_state_sha256;
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            ...receiptWithoutReuseTreeState,
            receipt_path: receiptPath,
            review_artifact_path: artifactPath,
            review_artifact_sha256: fileSha256(artifactPath),
            review_context_path: contextPath,
            review_context_sha256: fileSha256(contextPath),
            review_context_reuse_sha256: receipt.reused_from_review_context_reuse_sha256,
            review_tree_state_sha256: receipt.review_tree_state_sha256,
            reused_existing_review: true,
            reused_from_receipt_path: receiptPath,
            reused_from_review_context_sha256: receipt.reused_from_review_context_sha256,
            reused_from_review_context_reuse_sha256: receipt.reused_from_review_context_reuse_sha256
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('current-cycle REVIEW_RECORDED reuse telemetry'), result.reason);
    });

    it('blocks reused review receipts even when preserved invocation provenance is otherwise valid', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const reviewerProvenance = receipt.reviewer_provenance as Record<string, unknown>;
        receipt.reused_existing_review = true;
        receipt.reused_from_receipt_path = receiptPath;
        receipt.reused_from_review_context_sha256 = receipt.review_context_sha256;
        receipt.reused_from_review_context_reuse_sha256 = '7'.repeat(64);
        receipt.reused_from_review_tree_state_sha256 = reviewerProvenance.review_tree_state_sha256;
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('current-cycle REVIEW_RECORDED reuse telemetry'), result.reason);
        assert.equal(result.reason.includes('missing_timing'), false, result.reason);
    });

    it('continues to downstream review when strict reused review timing is bound to the original source', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'code');
        seedCompilePass(repoRoot, TASK_ID);
        appendCurrentStrictReuseRecorded(repoRoot, TASK_ID, 'code');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'test');
        assert.ok(result.commands[0].command.includes('--review-type "test"'));
        assert.equal(result.reason.includes("Required review 'code' evidence is not sufficiently trustworthy"), false);
    });

    it('routes hidden timing distrust back to review result with generic remediation only', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.review_output_source_mtime_utc = '2026-04-27T23:59:59.000Z';
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes("Required review 'code' evidence is not sufficiently trustworthy"), result.reason);
        assert.ok(result.reason.includes('Launch a real subagent using built-in tools'), result.reason);
        assert.equal(/timing|threshold|elapsed|duration|seconds|impossible_ordering|missing_timing/i.test(result.reason), false);
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });
});
