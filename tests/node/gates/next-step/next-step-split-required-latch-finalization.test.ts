import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './next-step-review-cycle-fixtures';

const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    buildReviewContextScopeFixture,
    eventsRoot,
    resolveNextStep,
    formatNextStepText,
    EXPECTED_LOOP_LINE,
    fileSha256,
    fs,
    getLoadedRuleFileBasenames,
    hasCompletedDecomposedParentAfterSplitRequiredClear,
    hasSplitRequiredClearedEvidence,
    launchInputEvidenceFixture,
    makeTempRepo,
    markReviewEvidenceAsStrictReuse,
    materializeFinalCloseout,
    NEXT_STEP_FULL_SUITE_TEST_CONFIG,
    normalizeForTimeline,
    os,
    path,
    PROVIDER_ENV_KEYS,
    readReviewContextTreeStateSha256,
    readSplitRequiredLatchEvidence,
    requireFromTest,
    resolveReviewCycleContinuationArtifactPath,
    resolveSplitRequiredArtifactPath,
    reviewsRoot,
    runRecordReviewCycleSplitDecisionCommand,
    seedCompilePass,
    seedCompletedReviewerLaunchAndInvocation,
    seedCompletedTaskWithIndependentCodeReview,
    seedCompletionPass,
    seedCustomStartedTask,
    seedDocImpactPass,
    seedFullSuiteValidation,
    seedGitAutoCompilePass,
    seedHandshake,
    seedPostPreflightRulePack,
    seedProjectMemory,
    seedProjectMemoryImpact,
    seedReviewGatePass,
    seedRulePack,
    seedShellSmoke,
    seedSourceCheckoutRuntime,
    seedSplitRequiredLatchEvidence,
    seedStartedTask,
    seedTaskModeOnly,
    sha256Text,
    TASK_ID,
    tempRoots,
    withProviderEnv,
    writeFreshReviewContextWithoutRouting,
    writeGitAutoPreflight,
    writeJson,
    writeJsonWithSha,
    writeNoOpEvidence,
    writePreflight,
    writeProjectMemoryWorkflowConfig,
    writeReviewContextOnly,
    writeReviewCycleContinuation,
    writeReviewEvidence,
    writeStrictDecompositionDecision,
    writeStrictIndependentCodeReviewEvidence
} = fx;
void [ALL_REVIEW_FLAGS, appendEvent, buildReviewContextScopeFixture, eventsRoot, resolveNextStep, formatNextStepText, EXPECTED_LOOP_LINE, fileSha256, fs, getLoadedRuleFileBasenames, hasCompletedDecomposedParentAfterSplitRequiredClear, hasSplitRequiredClearedEvidence, launchInputEvidenceFixture, makeTempRepo, markReviewEvidenceAsStrictReuse, materializeFinalCloseout, NEXT_STEP_FULL_SUITE_TEST_CONFIG, normalizeForTimeline, os, path, PROVIDER_ENV_KEYS, readReviewContextTreeStateSha256, readSplitRequiredLatchEvidence, requireFromTest, resolveReviewCycleContinuationArtifactPath, resolveSplitRequiredArtifactPath, reviewsRoot, runRecordReviewCycleSplitDecisionCommand, seedCompilePass, seedCompletedReviewerLaunchAndInvocation, seedCompletedTaskWithIndependentCodeReview, seedCompletionPass, seedCustomStartedTask, seedDocImpactPass, seedFullSuiteValidation, seedGitAutoCompilePass, seedHandshake, seedPostPreflightRulePack, seedProjectMemory, seedProjectMemoryImpact, seedReviewGatePass, seedRulePack, seedShellSmoke, seedSourceCheckoutRuntime, seedSplitRequiredLatchEvidence, seedStartedTask, seedTaskModeOnly, sha256Text, TASK_ID, tempRoots, withProviderEnv, writeFreshReviewContextWithoutRouting, writeGitAutoPreflight, writeJson, writeJsonWithSha, writeNoOpEvidence, writePreflight, writeProjectMemoryWorkflowConfig, writeReviewContextOnly, writeReviewCycleContinuation, writeReviewEvidence, writeStrictDecompositionDecision, writeStrictIndependentCodeReviewEvidence];

describe('gates/next-step split-required latch finalization', () => {
    it('preserves done status after gate-owned split-required child completion', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-652 | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-653` through `T-654`; do not continue the parent. |',
            '| T-653 | DONE | P1 | workflow | Child one | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-654 | DONE | P1 | workflow | Child two | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-652');
        const decomposedResult = resolveNextStep({ taskId: 'T-652', repoRoot });
        const doneResult = resolveNextStep({ taskId: 'T-652', repoRoot });
        const stableDoneResult = resolveNextStep({ taskId: 'T-652', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-652.jsonl'), 'utf8');

        assert.equal(decomposedResult.status, 'DECOMPOSED');
        assert.equal(doneResult.status, 'DONE');
        assert.equal(stableDoneResult.status, 'DONE');
        assert.equal(stableDoneResult.next_gate, null);
        assert.ok(taskMd.includes('| T-652 | DONE |'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_CLEARED"'));
        assert.ok(events.includes('"event_type":"DECOMPOSED_PARENT_COMPLETED"'));
        assert.equal((events.match(/"event_type":"SPLIT_REQUIRED_RESTORED"/g) || []).length, 0);
    });

    it('finalizes split-required parents through parent-derived suffixed child tasks', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-506 | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-506-1` and `T-506-2`; do not continue the parent. |',
            '| T-506-1 | DONE | P1 | workflow | Child one | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-506-2 | DONE | P1 | workflow | Child two | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-506');

        const decomposedResult = resolveNextStep({ taskId: 'T-506', repoRoot });
        const doneResult = resolveNextStep({ taskId: 'T-506', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-506.jsonl'), 'utf8');

        assert.equal(decomposedResult.status, 'DECOMPOSED');
        assert.equal(doneResult.status, 'DONE');
        assert.ok(taskMd.includes('| T-506 | DONE |'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_CLEARED"'));
        assert.ok(events.includes('"event_type":"DECOMPOSED_PARENT_COMPLETED"'));
    });

    it('finalizes nested decomposed parents when parent-derived leaf children are already done', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-700 | 🟪 DECOMPOSED | P1 | workflow | Root parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-700-1` through normal gates. |',
            '| T-700-1 | 🟪 DECOMPOSED | P1 | workflow | Nested parent | gpt-5.5 | 2026-05-06 | strict | Execute child tasks `T-700-1-1` and `T-700-1-2` through normal gates. |',
            '| T-700-1-1 | 🟩 DONE | P1 | workflow | First leaf | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            '| T-700-1-2 | 🟩 DONE | P1 | workflow | Second leaf | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-700', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DONE');
        assert.equal(result.next_gate, null);
        assert.ok(taskMd.includes('| T-700 | 🟩 DONE |'));
        assert.ok(taskMd.includes('| T-700-1 | 🟩 DONE |'));
    });

    it('transitions a reset split-required parent to decomposed when child tasks are linked', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-646 | TODO | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-647` through `T-648`; do not continue the parent. |',
            '| T-647 | DONE | P1 | workflow | Child one | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-648 | TODO | P1 | workflow | Child two | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-646');

        const result = resolveNextStep({ taskId: 'T-646', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-646.jsonl'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-648"'));
        assert.ok(result.reason.includes('stayed permanent after later status/config/scope drift'));
        assert.ok(taskMd.includes('| T-646 | DECOMPOSED |'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_RESTORED"'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_CLEARED"'));
    });

    it('does not clear split-required latch for unrelated task mentions in parent notes', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-638 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Related to `T-639`. Child tasks still need to be created and linked. |',
            '| T-639 | 🟦 TODO | P1 | workflow | Related task | gpt-5.4 | 2026-05-05 | strict | Independent follow-up. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-638');

        const result = resolveNextStep({ taskId: 'T-638', repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('cannot continue through classify, compile, review, full-suite, completion, or final closeout gates'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-638 | 🟫 SPLIT_REQUIRED |'));
        assert.ok(text.includes('Status: SPLIT_REQUIRED'));
    });

    it('does not clear split-required latch for follow-up task commands without explicit child wording', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-636 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Execute `T-637` as a separate follow-up task after this split is planned. |',
            '| T-637 | 🟦 TODO | P1 | workflow | Follow-up task | gpt-5.4 | 2026-05-05 | strict | Independent follow-up. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-636');

        const result = resolveNextStep({ taskId: 'T-636', repoRoot });

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-636 | 🟫 SPLIT_REQUIRED |'));
    });

    it('clears split-required parent to decomposed when linked child tasks exist', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-640 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-641` through `T-642`; do not continue the parent. |',
            '| T-641 | 🟩 DONE | P1 | workflow | Child one | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-642 | 🟦 TODO | P1 | workflow | Child two | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-640');

        const result = resolveNextStep({ taskId: 'T-640', repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-642"'));
        assert.ok(result.reason.includes('transitioned the parent from SPLIT_REQUIRED to DECOMPOSED'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-640 | 🟪 DECOMPOSED |'));
        assert.ok(text.includes('Status: DECOMPOSED'));
    });

});

