import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { initGitRepo } from '../git-fixtures';
import * as fx from './next-step-review-reuse-fixtures';

const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    fs,
    makeTempRepo,
    markReviewEvidenceAsStrictReuse,
    path,
    resolveNextStep,
    reviewsRoot,
    seedCompilePass,
    seedGitAutoCompilePass,
    seedPostPreflightRulePack,
    seedReviewGatePass,
    seedStartedTask,
    TASK_ID,
    writeGitAutoPreflight,
    writeJson,
    writePreflight,
    writeReviewEvidence
} = fx;

function commandText(result: { commands?: Array<{ command?: string }> }): string {
    return result.commands?.[0]?.command || '';
}

function markTaskInProgress(repoRoot: string, taskId: string): void {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const content = fs.readFileSync(taskPath, 'utf8');
    fs.writeFileSync(
        taskPath,
        content.replace(`| ${taskId} | TODO |`, `| ${taskId} | IN_PROGRESS |`),
        'utf8'
    );
}

function seedReviewGatePassWithOverride(repoRoot: string, taskId: string, skippedReviewTypes: string[]): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-review-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        skip_reviews: skippedReviewTypes,
        review_authorship_attestation: {
            schema_version: 1,
            skipped_review_types: skippedReviewTypes
        }
    });
    appendEvent(repoRoot, taskId, 'REVIEW_GATE_PASSED_WITH_OVERRIDE', 'PASS', {
        skip_reviews: skippedReviewTypes,
        review_authorship_attestation: {
            schema_version: 1,
            skipped_review_types: skippedReviewTypes
        }
    });
}

function assertNoUnexpectedReviewWork(
    result: { commands?: Array<{ command?: string }> },
    options: {
        allowBuildReviewContext?: boolean;
        allowRequiredReviewsCheck?: boolean;
        allowRestartReviewCycle?: boolean;
    } = {}
): void {
    const forbiddenFragments = [
        'gate prepare-reviewer-launch',
        'gate record-review-routing',
        'gate record-reviewer-delegation-started',
        'gate complete-reviewer-launch',
        'gate record-review-result'
    ];
    if (!options.allowBuildReviewContext) {
        forbiddenFragments.push('gate build-review-context');
    }
    if (!options.allowRequiredReviewsCheck) {
        forbiddenFragments.push('gate required-reviews-check');
    }
    if (!options.allowRestartReviewCycle) {
        forbiddenFragments.push('gate restart-review-cycle');
    }
    const commands = result.commands?.map((entry) => entry.command || '') || [];
    for (const fragment of forbiddenFragments) {
        for (const candidateCommand of commands) {
            assert.ok(
                !candidateCommand.includes(fragment),
                `unexpected review command fragment: ${fragment}\n${candidateCommand}`
            );
        }
    }
}

describe('gates/next-step post-review navigation invariants', () => {
    it('advances accepted current PASS reuse to the review gate without launch or rebind churn', () => {
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
        assertNoUnexpectedReviewWork(result, { allowRequiredReviewsCheck: true });
    });

    it('does not rebind or relaunch review lanes after the review gate already passed', () => {
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
        seedReviewGatePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'build-review-context', result.reason);
        assert.notEqual(result.next_gate, 'prepare-reviewer-launch', result.reason);
        assert.equal(result.next_gate, 'doc-impact-gate', result.reason);
        assertNoUnexpectedReviewWork(result);
    });

    it('treats review gate override skipped lanes as satisfied for closeout routing', () => {
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
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        seedReviewGatePassWithOverride(repoRoot, TASK_ID, ['code']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.review.next_review_type, null, result.reason);
        assert.equal(result.next_gate, 'doc-impact-gate', result.reason);
        assertNoUnexpectedReviewWork(result);
    });

    it('does not satisfy missing review lanes that the review gate override did not skip', () => {
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
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        seedReviewGatePassWithOverride(repoRoot, TASK_ID, ['test']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = commandText(result);

        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.ok(command.includes('--review-type "code"'), command);
        assertNoUnexpectedReviewWork(result, { allowBuildReviewContext: true });
    });

    it('refreshes preflight instead of restarting failed review when remediation adds expanded non-test files', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        markTaskInProgress(repoRoot, TASK_ID);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        fs.writeFileSync(path.join(repoRoot, 'src', 'extra.ts'), 'export const extra = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = commandText(result);

        assert.equal(result.next_gate, 'classify-change', result.reason);
        assert.match(result.title, /expanded 'code' remediation scope/);
        assert.match(result.reason, /restart-review-cycle would fail its scope-boundary guard/);
        assert.ok(command.includes('--changed-file "src/app.ts"'), command);
        assert.ok(command.includes('--changed-file "src/extra.ts"'), command);
        assertNoUnexpectedReviewWork(result);
    });

    it('routes test-only remediation with upstream lane reuse to rebind without launching fresh reviewers', () => {
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
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'code');
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
        assert.match(result.title, /Prepare 'code' review context/);
        assert.ok(commandText(result).includes('--review-type "code"'));
        assertNoUnexpectedReviewWork(result, { allowBuildReviewContext: true });
    });

    it('keeps attestation-only review-gate failures on required-reviews-check with satisfied review lanes attested', () => {
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
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_FAILED', 'FAIL', {
            review_authorship_attestation: {
                status: 'FAILED',
                false_review_types: ['code', 'test'],
                violations: [
                    'Review authorship attestation is false for mandatory review types: code, test. Fresh delegated reviewer output/receipt is not honestly attested for those lanes.'
                ]
            },
            violations: [
                'Review authorship attestation is false for mandatory review types: code, test. Fresh delegated reviewer output/receipt is not honestly attested for those lanes.'
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = commandText(result);

        assert.equal(result.next_gate, 'required-reviews-check', result.reason);
        assert.ok(command.includes('--review-authorship-attestation-json'), command);
        assert.ok(command.includes('{"code":true,"test":true}'), command);
        assertNoUnexpectedReviewWork(result, { allowRequiredReviewsCheck: true });
    });

    it('routes zero-diff no-review closeout to record-no-op without review work', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'empty';
        preflight.zero_diff_guard = {
            zero_diff_detected: true,
            status: 'BASELINE_ONLY',
            completion_requires_audited_no_op: true
        };
        preflight.profile_guardrails = {
            zero_diff_no_reviewable_scope: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedGitAutoCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-no-op', result.reason);
        assert.ok(commandText(result).includes('gate record-no-op'));
        assertNoUnexpectedReviewWork(result);
    });

    it('keeps same-scope failed-review remediation on restart-review-cycle without starting fresh reviewers', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        markTaskInProgress(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-review-cycle', result.reason);
        assertNoUnexpectedReviewWork(result, { allowRestartReviewCycle: true });
    });
});
