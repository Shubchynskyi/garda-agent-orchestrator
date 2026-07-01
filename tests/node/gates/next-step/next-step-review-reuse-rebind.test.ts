import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './next-step-review-reuse-fixtures';
const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    assertGateChainDecision,
    buildReviewReuseCandidatesForDiagnostics,
    fileSha256,
    formatNextStepText,
    fs,
    makeTempRepo,
    markReviewEvidenceAsStrictReuse,
    path,
    resolveNextStep,
    reviewsRoot,
    seedCompilePass,
    seedReviewGatePass,
    seedRulePack,
    seedStartedTask,
    TASK_ID,
    writeJson,
    writePreflight,
    writeReviewEvidence
} = fx;
void [assert];
describe('gates/next-step review reuse rebind routing', () => {
    it('does not treat stale pre-compile review routing as upstream pass evidence', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing');
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('current REVIEWER_DELEGATION_ROUTED telemetry'));
        assertGateChainDecision(result.reason, {
            edgeId: 'review-context-to-routing',
            status: 'pass'
        });
        assert.ok(result.reason.includes('LaneScope=review_type'));
        assert.ok(result.reason.includes('opaque handoff artifact'));
        assert.ok(result.reason.includes('Do not open or summarize'));
        assert.ok(result.reason.includes('new clean-context delegated reviewer'));
        assert.ok(result.reason.includes('provider-native/internal agent or subagent tool'));
        assert.ok(result.reason.includes('not a shell command or hand-written artifact'));
        assert.ok(result.reason.includes('do not reuse an existing reviewer session'));
        assert.ok(result.reason.includes('fork_context=false'));
        assert.ok(result.reason.includes('If the current provider session cannot launch a fresh delegated reviewer, stop and report that blocker'));
        assert.ok(result.reason.includes('instead of fabricating routing, launch, review, receipt, or telemetry evidence'));
        assert.ok(result.reason.includes('Reviewer readiness chain: preflight scope=current -> review context=current'));
        assert.ok(result.reason.includes('routing=missing current-cycle telemetry'));
        assert.ok(result.reason.includes('launch artifact=blocked until routing'));
        assert.equal(result.commands[0].label, 'Record fresh delegated review routing');
    });

    it('rebinds downstream strict-sequential review when upstream reuse is recorded after downstream phase', () => {
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
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.ok(result.reason.includes("latest review phase predates the upstream review record"), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
    });

    it('advances to review gate when downstream current PASS context reuse is accepted after upstream remediation', () => {
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
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_CONTEXT_REUSE_ACCEPTED', 'PASS', {
            review_type: 'test',
            current_pass_review_evidence: true,
            output_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-test-review-context.json`)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'required-reviews-check', result.reason);
        assert.ok(result.commands[0].command.includes('gate required-reviews-check'));
        assert.ok(!result.commands[0].command.includes('build-review-context'));
        assert.ok(!result.reason.includes('latest review phase predates the upstream review record'));
    });

    it('routes restarted downstream rebind through upstream reuse materialization first', () => {
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
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', { restarted: true });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        appendEvent(repoRoot, TASK_ID, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
        appendEvent(repoRoot, TASK_ID, 'SHELL_SMOKE_PREFLIGHT_RECORDED');

        const testFile = path.join(repoRoot, 'tests', 'restart-cycle.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("restart cycle", () => {});\n', 'utf8');
        const restartedPreflightPath = writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/restart-cycle.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        const restartedTaskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`);
        const restartedCompileEvidencePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`);
        appendEvent(repoRoot, TASK_ID, 'COHERENT_CYCLE_RESTARTED', 'PASS', {
            restart_event_schema_version: 1,
            task_id: TASK_ID,
            event_type: 'COHERENT_CYCLE_RESTARTED',
            task_mode_path: restartedTaskModePath.replace(/\\/g, '/'),
            task_mode_sha256: fileSha256(restartedTaskModePath),
            preflight_path: restartedPreflightPath.replace(/\\/g, '/'),
            preflight_sha256: fileSha256(restartedPreflightPath),
            compile_evidence_path: restartedCompileEvidencePath.replace(/\\/g, '/'),
            compile_evidence_sha256: fileSha256(restartedCompileEvidencePath),
            detected_changed_files_count: 2,
            elapsed_ms: 1,
            restart_reason: 'coherent_cycle_restart_after_downstream_boundary_or_invalid_preflight_order',
            next_step_summary: 'continue restarted downstream rebind through upstream reuse materialization'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse before downstream 'test'/);
        assert.match(result.reason, /validate reuse eligibility before treating that PASS evidence as reusable/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('does not rebind downstream strict-sequential review after the review gate passed', () => {
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
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });
        seedReviewGatePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate', result.reason);
        assert.ok(!result.commands[0].command.includes('build-review-context'));
        assert.ok(!result.reason.includes('latest review phase predates the upstream review record'));
    });

    it('materializes upstream code reuse before downstream test after test-only remediation', () => {
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

        const testFile = path.join(repoRoot, 'tests', 'review-domain.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review domain", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-domain.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'test', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse before downstream 'test'/);
        assert.match(result.reason, /validate reuse eligibility before treating that PASS evidence as reusable/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('materializes upstream code reuse before downstream refactor after test-only remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const testFile = path.join(repoRoot, 'tests', 'strict-reuse-remediation.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("strict reuse remediation", () => {});\n', 'utf8');
        const changedFiles = ['src/app.ts', 'tests/strict-reuse-remediation.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');

        fs.writeFileSync(
            testFile,
            'test("strict reuse remediation", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'refactor', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse before downstream 'refactor'/);
        assert.match(result.reason, /validate reuse eligibility before treating that PASS evidence as reusable/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
        assert.ok(!result.commands[0].command.includes('--review-type "refactor"'));

        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });

        const securityResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(securityResult.next_gate, 'build-review-context', securityResult.reason);
        assert.equal(securityResult.review.next_review_type, 'refactor', securityResult.reason);
        assert.match(securityResult.title, /Materialize 'security' review reuse before downstream 'refactor'/);
        assert.match(securityResult.reason, /validate reuse eligibility before treating that PASS evidence as reusable/);
        assert.ok(!securityResult.commands[0].command.includes('--review-type "code"'));
        assert.ok(securityResult.commands[0].command.includes('--review-type "security"'));
        assert.ok(!securityResult.commands[0].command.includes('--review-type "refactor"'));
        assert.deepEqual(securityResult.invalidation_impact?.affected_review_lanes, ['security', 'refactor', 'test']);
        assert.deepEqual(securityResult.invalidation_impact?.minimal_recovery_chain, [
            'build-review-context',
            'materialize current-cycle review reuse',
            'rerun navigator before downstream review/check gates'
        ]);
        assert.deepEqual(securityResult.invalidation_impact?.reuse_candidates, ['none indicated']);
    });

    it('re-materializes stale upstream reuse after a later compile before downstream refactor', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const testFile = path.join(repoRoot, 'tests', 'strict-reuse-repeat-remediation.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("strict reuse repeat remediation", () => {});\n', 'utf8');
        const changedFiles = ['src/app.ts', 'tests/strict-reuse-repeat-remediation.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'code');
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'security');
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'refactor');

        fs.writeFileSync(
            testFile,
            'test("strict reuse repeat remediation", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Prepare 'code' review context/);
        assert.match(result.reason, /review-context artifact is stale for the current preflight/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
        assert.ok(!result.commands[0].command.includes('--review-type "refactor"'));
        assert.deepEqual(result.invalidation_impact?.stale_artifact_classes, [
            'preflight/scope',
            'compile evidence',
            'review context',
            'reviewer routing',
            'reviewer launch/invocation',
            'review artifact/receipt'
        ]);
        assert.deepEqual(result.invalidation_impact?.affected_review_lanes, ['code', 'security', 'refactor', 'test']);
        assert.deepEqual(result.invalidation_impact?.reuse_candidates, ['none indicated']);

        const text = formatNextStepText(result);
        assert.match(text, /InvalidationImpact:/);
        assert.match(text, /AffectedReviewLanes: code, security, refactor, test/);
        assert.match(text, /ReuseCandidates: none indicated/);
    });

    it('routes review-gate stale upstream failures to upstream rebind instead of retrying the review gate', () => {
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
        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        const testFile = path.join(repoRoot, 'tests', 'review-gate-stale-upstream.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review gate stale upstream", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-gate-stale-upstream.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_FAILED', 'FAIL', {
            violations: [
                "Review 'code' is missing matching REVIEWER_DELEGATION_ROUTED telemetry in the current cycle."
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Recover stale upstream 'code' review evidence/);
        assert.ok(result.reason.includes('required-reviews-check failed after compile'), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.deepEqual(result.invalidation_impact?.stale_artifact_classes, [
            'preflight/scope',
            'compile evidence',
            'review context',
            'reviewer routing',
            'reviewer launch/invocation',
            'review artifact/receipt',
            'review gate evidence'
        ]);
        assert.deepEqual(result.invalidation_impact?.affected_review_lanes, ['code', 'test']);
        assert.deepEqual(result.invalidation_impact?.minimal_recovery_chain, [
            'build-review-context',
            'materialize current-cycle review reuse',
            'rerun navigator before downstream review/check gates'
        ]);
        assert.deepEqual(result.invalidation_impact?.reuse_candidates, ['none indicated']);
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
    });

    it('routes stale review contexts to rebind before required-reviews-check after coherent-cycle restart', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const changedFiles = ['src/app.ts', 'tests/rebound-context.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        const reboundPreflightPath = writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        const reboundPreflight = JSON.parse(fs.readFileSync(reboundPreflightPath, 'utf8'));
        writeJson(reboundPreflightPath, {
            ...reboundPreflight,
            coherent_cycle_rebound_marker: true
        });
        fx.seedPostPreflightRulePack(repoRoot, TASK_ID, reboundPreflightPath);
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Rebind stale 'code' review context before required reviews check/);
        assert.ok(result.reason.includes('required-reviews-check'), result.reason);
        assert.ok(result.reason.includes('known to fail'), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
    });

    it('routes review-gate stale upstream failures even when upstream context is current after a later compile', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-gate-later-compile.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_FAILED', 'FAIL', {
            violations: [
                "Review 'code' is missing matching REVIEWER_DELEGATION_ROUTED telemetry in the current cycle."
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Recover stale upstream 'code' review evidence/);
        assert.ok(result.reason.includes('required-reviews-check failed after compile'), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.match(result.reason, /reuse eligibility validation can run/);
        assert.deepEqual(result.invalidation_impact?.reuse_candidates, ['none indicated']);
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
    });

    it('keeps concrete reuse candidates visible when route text represents validated reuse', () => {
        const reuseCandidates = buildReviewReuseCandidatesForDiagnostics(
            "Recover stale upstream 'code' review evidence after review gate failure. " +
            "The latest required-reviews-check failed after compile, and upstream 'code' is lane-domain current " +
            "but its review-context/routing binding is stale for the current preflight. " +
            "Rebind 'code' through build-review-context/reuse before rerunning required-reviews-check.",
            ['code', 'test']
        );

        assert.deepEqual(reuseCandidates, [
            'code (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'test (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)'
        ]);
    });

    it('re-materializes lane-domain-current reused review evidence after a later compile', () => {
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

        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code.md`);
        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const originalPreflight = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')
        ) as Record<string, unknown>;
        const originalPreflightMetrics = originalPreflight.metrics as Record<string, unknown>;
        const originalLegacyScopes = ((originalPreflightMetrics.domain_scope_fingerprints as Record<string, unknown>)
            .legacy || {}) as Record<string, unknown>;
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.review_scope_sha256 = originalLegacyScopes.review_scope_sha256;
        receipt.code_scope_sha256 = originalLegacyScopes.code_scope_sha256;
        writeJson(receiptPath, receipt);
        const reviewerProvenance = receipt.reviewer_provenance as Record<string, unknown>;
        const historicalReceiptSha256 = fileSha256(receiptPath);
        const historicalReceiptSnapshotPath = path.join(
            reviewsRoot(repoRoot),
            `${TASK_ID}-code-receipt-${historicalReceiptSha256}.json`
        );
        fs.copyFileSync(receiptPath, historicalReceiptSnapshotPath);
        const historicalContextSha256 = fileSha256(contextPath);
        const reviewArtifactSha256 = fileSha256(artifactPath);
        const reviewArtifactSnapshotPath = path.join(
            reviewsRoot(repoRoot),
            `${TASK_ID}-code-artifact-${reviewArtifactSha256}.md`
        );
        fs.copyFileSync(artifactPath, reviewArtifactSnapshotPath);
        const currentReviewContextReuseSha256 = '7'.repeat(64);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            ...receipt,
            receipt_path: receiptPath,
            receipt_sha256: historicalReceiptSha256,
            receipt_snapshot_path: historicalReceiptSnapshotPath,
            receipt_snapshot_sha256: historicalReceiptSha256,
            review_artifact_path: artifactPath,
            review_artifact_sha256: reviewArtifactSha256,
            review_artifact_snapshot_path: reviewArtifactSnapshotPath,
            review_artifact_snapshot_sha256: reviewArtifactSha256,
            review_context_path: contextPath,
            review_context_sha256: historicalContextSha256,
            review_context_reuse_sha256: currentReviewContextReuseSha256,
            review_tree_state_sha256: receipt.review_tree_state_sha256
        });
        receipt.reused_existing_review = true;
        receipt.reused_from_receipt_path = receiptPath;
        receipt.reused_from_receipt_sha256 = historicalReceiptSha256;
        receipt.review_context_reuse_sha256 = currentReviewContextReuseSha256;
        receipt.reused_from_review_context_sha256 = historicalContextSha256;
        receipt.reused_from_review_context_reuse_sha256 = currentReviewContextReuseSha256;
        receipt.reused_from_review_tree_state_sha256 = reviewerProvenance.review_tree_state_sha256;
        receipt.reused_from_review_scope_sha256 = receipt.review_scope_sha256;
        receipt.reused_from_code_scope_sha256 = receipt.code_scope_sha256;
        writeJson(receiptPath, receipt);
        const currentReceiptSha256 = fileSha256(receiptPath);
        const currentReceiptSnapshotPath = path.join(
            reviewsRoot(repoRoot),
            `${TASK_ID}-code-receipt-${currentReceiptSha256}.json`
        );
        fs.copyFileSync(receiptPath, currentReceiptSnapshotPath);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            ...receipt,
            receipt_path: receiptPath,
            receipt_sha256: currentReceiptSha256,
            receipt_snapshot_path: currentReceiptSnapshotPath,
            receipt_snapshot_sha256: currentReceiptSha256,
            review_artifact_path: artifactPath,
            review_artifact_sha256: reviewArtifactSha256,
            review_artifact_snapshot_path: reviewArtifactSnapshotPath,
            review_artifact_snapshot_sha256: reviewArtifactSha256,
            review_context_path: contextPath,
            review_context_sha256: historicalContextSha256,
            review_context_reuse_sha256: currentReviewContextReuseSha256,
            review_tree_state_sha256: receipt.review_tree_state_sha256
        });

        const testFile = path.join(repoRoot, 'tests', 'review-domain.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review domain", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-domain.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Prepare 'code' review context/);
        assert.match(result.reason, /review-context artifact is stale for the current preflight/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });
});
