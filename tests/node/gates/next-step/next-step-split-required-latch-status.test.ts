import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './next-step-review-cycle-fixtures';

const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    buildReviewContextScopeFixture,
    eventsRoot,
    buildTaskModeArtifact,
    getWorkspaceSnapshot,
    buildDefaultWorkflowConfig,
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
void [ALL_REVIEW_FLAGS, appendEvent, buildReviewContextScopeFixture, eventsRoot, buildTaskModeArtifact, getWorkspaceSnapshot, buildDefaultWorkflowConfig, resolveNextStep, formatNextStepText, EXPECTED_LOOP_LINE, fileSha256, fs, getLoadedRuleFileBasenames, hasCompletedDecomposedParentAfterSplitRequiredClear, hasSplitRequiredClearedEvidence, launchInputEvidenceFixture, makeTempRepo, markReviewEvidenceAsStrictReuse, materializeFinalCloseout, NEXT_STEP_FULL_SUITE_TEST_CONFIG, normalizeForTimeline, os, path, PROVIDER_ENV_KEYS, readReviewContextTreeStateSha256, readSplitRequiredLatchEvidence, requireFromTest, resolveReviewCycleContinuationArtifactPath, resolveSplitRequiredArtifactPath, reviewsRoot, runRecordReviewCycleSplitDecisionCommand, seedCompilePass, seedCompletedReviewerLaunchAndInvocation, seedCompletedTaskWithIndependentCodeReview, seedCompletionPass, seedCustomStartedTask, seedDocImpactPass, seedFullSuiteValidation, seedGitAutoCompilePass, seedHandshake, seedPostPreflightRulePack, seedProjectMemory, seedProjectMemoryImpact, seedReviewGatePass, seedRulePack, seedShellSmoke, seedSourceCheckoutRuntime, seedSplitRequiredLatchEvidence, seedStartedTask, seedTaskModeOnly, sha256Text, TASK_ID, tempRoots, withProviderEnv, writeFreshReviewContextWithoutRouting, writeGitAutoPreflight, writeJson, writeJsonWithSha, writeNoOpEvidence, writePreflight, writeProjectMemoryWorkflowConfig, writeReviewContextOnly, writeReviewCycleContinuation, writeReviewEvidence, writeStrictDecompositionDecision, writeStrictIndependentCodeReviewEvidence];

describe('gates/next-step split-required latch status', () => {
    it('resolves and validates split-required latch helper evidence directly', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-681 | SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-682`. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-681', 'review_cycle');

        const latchEvidence = readSplitRequiredLatchEvidence({
            reviewsRoot: reviewsRoot(repoRoot),
            eventsRoot: eventsRoot(repoRoot),
            taskId: 'T-681'
        });

        assert.equal(
            resolveSplitRequiredArtifactPath(reviewsRoot(repoRoot), 'T-681'),
            path.join(reviewsRoot(repoRoot), 'T-681-split-required.json')
        );
        assert.equal(latchEvidence.valid, true);
        assert.equal(latchEvidence.guard_kind, 'review_cycle');
        assert.equal(hasSplitRequiredClearedEvidence({
            eventsRoot: eventsRoot(repoRoot),
            taskId: 'T-681',
            latchEvidence
        }), false);

        appendEvent(repoRoot, 'T-681', 'SPLIT_REQUIRED_CLEARED', 'INFO', {
            previous_status: 'SPLIT_REQUIRED',
            new_status: 'DECOMPOSED',
            reason: 'child_tasks_linked'
        });

        assert.equal(hasSplitRequiredClearedEvidence({
            eventsRoot: eventsRoot(repoRoot),
            taskId: 'T-681',
            latchEvidence
        }), true);
        assert.equal(hasCompletedDecomposedParentAfterSplitRequiredClear({
            eventsRoot: eventsRoot(repoRoot),
            taskId: 'T-681',
            latchEvidence
        }), false);

        appendEvent(repoRoot, 'T-681', 'DECOMPOSED_PARENT_COMPLETED', 'INFO', {
            previous_status: 'DECOMPOSED',
            new_status: 'DONE',
            reason: 'explicit_children_done'
        });

        assert.equal(hasCompletedDecomposedParentAfterSplitRequiredClear({
            eventsRoot: eventsRoot(repoRoot),
            taskId: 'T-681',
            latchEvidence
        }), true);
    });

    it('latches oversized strict-profile scopes as split-required before compile', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/scope-budget | Add decomposition guard | gpt-5.4 | 2026-05-03 | strict | Test queue entry. |`,
            ''
        ].join('\n'), 'utf8');
        const changedFiles = Array.from({ length: 13 }, (_, index) => `src/file-${index}.ts`);
        for (const filePath of changedFiles) {
            fs.writeFileSync(path.join(repoRoot, filePath), 'export const value = 1;\n', 'utf8');
        }
        seedStartedTask(repoRoot, TASK_ID);
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            detection_source: snapshot.detection_source,
            mode: 'FULL_PATH',
            scope_category: 'code',
            metrics: {
                changed_files_count: snapshot.changed_files.length,
                changed_lines_total: snapshot.changed_lines_total,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            required_reviews: { ...ALL_REVIEW_FLAGS, code: true, security: true, refactor: true, test: true },
            changed_files: changedFiles,
            review_execution_policy: {
                mode: 'code_first_optional',
                visible_summary_line: 'Review execution policy: code_first_optional'
            },
            profile_selection: {
                task_profile: 'strict',
                profile_selection_source: 'task_queue',
                effective_profile: 'strict',
                effective_profile_source: 'built_in',
                runtime_active_profile: 'balanced',
                runtime_profile_source: 'built_in'
            },
            budget_forecast: {
                total_estimated_review_tokens: 9000
            }
        });
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(preflightPath)
        });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'single-cycle',
            taskSummary: 'Seeded next-step task',
            expectedReviewTypes: ['code', 'security', 'refactor', 'test']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('configured budget exceeded: changed_files_count'));
        assert.equal(result.reason.includes('13>12'), false);
        assert.ok(text.includes('Status: SPLIT_REQUIRED'));
        assert.ok(text.includes('NextGate: split-required-latch'));
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes(`| ${TASK_ID} | SPLIT_REQUIRED |`));
        const latchPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-split-required.json`);
        assert.equal(fs.existsSync(latchPath), true);
        const latch = JSON.parse(fs.readFileSync(latchPath, 'utf8')) as Record<string, unknown>;
        assert.equal(latch.status, 'SPLIT_REQUIRED');
        assert.equal(latch.guard_kind, 'scope_budget');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8');
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_LATCHED"'));
        assert.ok(events.includes('"new_status":"SPLIT_REQUIRED"'));
    });

    it('keeps split-required latch ahead of ordinary recovery after the diff shrinks', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | SPLIT_REQUIRED | P1 | workflow/scope-budget | Add decomposition guard | gpt-5.4 | 2026-05-03 | strict | Guard latched; split into child tasks later. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedSplitRequiredLatchEvidence(repoRoot, TASK_ID);
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(preflightPath.endsWith(`${TASK_ID}-preflight.json`), true);
        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('cannot continue through classify, compile, review, full-suite, completion, or final closeout gates'));
        assert.ok(text.includes('Status: SPLIT_REQUIRED'));
    });

    it('restores split-required latch after a parent status reset and budget config increase', () => {
        const repoRoot = makeTempRepo();
        const config = buildDefaultWorkflowConfig();
        config.full_suite_validation.enabled = false;
        config.full_suite_validation.command = 'npm test';
        config.review_execution_policy = { mode: 'code_first_optional' };
        config.scope_budget_guard.max_files = 999999;
        config.scope_budget_guard.max_changed_lines = 999999;
        config.scope_budget_guard.max_required_reviews = 999999;
        config.scope_budget_guard.max_review_tokens = 999999;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), config);
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/scope-budget | Add decomposition guard | gpt-5.4 | 2026-05-03 | strict | Latch artifact still exists after a reset attempt. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedSplitRequiredLatchEvidence(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8');

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('permanent for this task attempt'));
        assert.ok(taskMd.includes(`| ${TASK_ID} | SPLIT_REQUIRED |`));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_RESTORED"'));
        assert.ok(text.includes('Status: SPLIT_REQUIRED'));
    });

    it('restores split-required latch after a parent status is changed to done', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | DONE | P1 | workflow/scope-budget | Add decomposition guard | gpt-5.4 | 2026-05-03 | strict | Latch artifact still exists after a terminal status edit. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedSplitRequiredLatchEvidence(repoRoot, TASK_ID);
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8');

        assert.equal(result.status, 'SPLIT_REQUIRED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('permanent for this task attempt'));
        assert.ok(taskMd.includes(`| ${TASK_ID} | SPLIT_REQUIRED |`));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_RESTORED"'));
    });

    it('does not let a hand-edited decomposed status bypass split-required clear evidence', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-649 | DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-650` through `T-651`; do not continue the parent. |',
            '| T-650 | DONE | P1 | workflow | Child one | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-651 | DONE | P1 | workflow | Child two | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-649');

        const result = resolveNextStep({ taskId: 'T-649', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), 'T-649.jsonl'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.notEqual(result.status, 'DONE');
        assert.equal(result.next_gate, null);
        assert.ok(result.reason.includes('stayed permanent after later status/config/scope drift'));
        assert.ok(taskMd.includes('| T-649 | DECOMPOSED |'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_RESTORED"'));
        assert.ok(events.includes('"event_type":"SPLIT_REQUIRED_CLEARED"'));
        assert.equal(events.includes('"event_type":"DECOMPOSED_PARENT_COMPLETED"'), false);
    });

    it('blocks split-required parent clearing while the shared TASK.md status lock is held', () => {
        const repoRoot = makeTempRepo();
        const taskPath = path.join(repoRoot, 'TASK.md');
        const lockPath = `${taskPath}.garda-status-sync.lock`;
        fs.writeFileSync(taskPath, [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-980 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-981` through `T-982`; do not continue the parent. |',
            '| T-981 | 🟩 DONE | P1 | workflow | Child one | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-982 | 🟦 TODO | P1 | workflow | Child two | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');
        seedSplitRequiredLatchEvidence(repoRoot, 'T-980');
        fs.writeFileSync(lockPath, 'held by another status sync\n', 'utf8');

        try {
            const result = resolveNextStep({ taskId: 'T-980', repoRoot });
            const taskMd = fs.readFileSync(taskPath, 'utf8');

            assert.equal(result.status, 'SPLIT_REQUIRED');
            assert.equal(result.next_gate, 'split-required-latch');
            assert.ok(result.reason.includes('Could not acquire TASK.md status-sync lock'));
            assert.ok(taskMd.includes('| T-980 | 🟫 SPLIT_REQUIRED |'));
        } finally {
            fs.unlinkSync(lockPath);
        }
    });

    it('blocks spoofed split-required rows with child notes but no latch evidence', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-634 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: `T-635`. |',
            '| T-635 | 🟦 TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Possible child. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-634', repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.match(result.reason, /latch evidence is invalid/i);
        assert.equal(result.commands.length, 0);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-634 | 🟫 SPLIT_REQUIRED |'));
    });

    it('blocks split-required latch clearing when artifact status-sync fields are inconsistent', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-632';
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-632 | 🟫 SPLIT_REQUIRED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: `T-633`. |',
            '| T-633 | 🟦 TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Possible child. |',
            ''
        ].join('\n'), 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS, code: true });
        const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-split-required.json`);
        const artifactSha256 = writeJsonWithSha(artifactPath, {
            schema_version: 1,
            timestamp_utc: new Date().toISOString(),
            task_id: taskId,
            status: 'SPLIT_REQUIRED',
            guard_kind: 'scope_budget',
            guard_reason: 'test guard',
            raw_guard_summary: 'test guard',
            preflight_path: normalizeForTimeline(preflightPath),
            preflight_sha256: fileSha256(preflightPath),
            materialization_phase: 'complete',
            status_sync: {
                outcome: 'already_synced',
                previous_status: 'SPLIT_REQUIRED',
                next_status: 'TODO',
                error_message: null
            },
            next_actions: [],
            guard_details: {}
        });
        appendEvent(repoRoot, taskId, 'SPLIT_REQUIRED_LATCHED', 'BLOCKED', {
            status: 'SPLIT_REQUIRED',
            guard_kind: 'scope_budget',
            artifact_path: normalizeForTimeline(artifactPath),
            artifact_sha256: artifactSha256
        });

        const result = resolveNextStep({ taskId, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.match(result.reason, /status_sync\.next_status is not SPLIT_REQUIRED/i);
        assert.ok(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8').includes('| T-632 | 🟫 SPLIT_REQUIRED |'));
    });

    it('does not record split-required latch event when TASK.md status sync fails', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-644';
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-645 | TODO | P1 | workflow | Different task | gpt-5.4 | 2026-05-03 | strict | Present row. |',
            ''
        ].join('\n'), 'utf8');
        const changedFiles = Array.from({ length: 13 }, (_, index) => `src/sync-fail-${index}.ts`);
        for (const filePath of changedFiles) {
            fs.writeFileSync(path.join(repoRoot, filePath), 'export const value = 1;\n', 'utf8');
        }
        writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), buildTaskModeArtifact({
            taskId,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Missing task row split latch',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            taskProfile: 'strict',
            profileSelectionSource: 'workspace_active',
            activeProfile: 'strict',
            profileSource: 'built_in',
            runtimeActiveProfile: 'balanced',
            runtimeProfileSource: 'built_in'
        }));
        writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
        writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
        appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, taskId, 'TASK_ENTRY');
        appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
        appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
        const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
        writeJson(preflightPath, {
            task_id: taskId,
            detection_source: snapshot.detection_source,
            mode: 'FULL_PATH',
            scope_category: 'code',
            metrics: {
                changed_files_count: snapshot.changed_files.length,
                changed_lines_total: snapshot.changed_lines_total,
                changed_files_sha256: snapshot.changed_files_sha256,
                scope_content_sha256: snapshot.scope_content_sha256,
                scope_sha256: snapshot.scope_sha256
            },
            required_reviews: { ...ALL_REVIEW_FLAGS, code: true, security: true, refactor: true, test: true },
            changed_files: changedFiles,
            review_execution_policy: {
                mode: 'code_first_optional',
                visible_summary_line: 'Review execution policy: code_first_optional'
            },
            profile_selection: {
                task_profile: 'strict',
                profile_selection_source: 'workspace_active',
                effective_profile: 'strict',
                effective_profile_source: 'built_in',
                runtime_active_profile: 'balanced',
                runtime_profile_source: 'built_in'
            },
            budget_forecast: {
                total_estimated_review_tokens: 9000
            }
        });
        appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(preflightPath)
        });
        seedPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const result = resolveNextStep({ taskId, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.match(result.reason, /TASK\.md status sync failed/i);
        const latch = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${taskId}-split-required.json`), 'utf8')) as Record<string, unknown>;
        assert.deepEqual(latch.status_sync, {
            outcome: 'task_not_found',
            previous_status: null,
            next_status: 'SPLIT_REQUIRED',
            error_message: null
        });
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${taskId}.jsonl`), 'utf8');
        assert.equal(events.includes('"event_type":"SPLIT_REQUIRED_LATCHED"'), false);
    });

    it('regresses review-cycle auto-split TASK.md sync failure without latch event', () => {
        const repoRoot = makeTempRepo();
        const taskId = 'T-646';
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: true
                }
            }
        );
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-647 | TODO | P1 | workflow | Different task | gpt-5.4 | 2026-05-03 | strict | Present row. |',
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, taskId);
        writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS, code: true });
        appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:auto-split-code-0',
            review_context_sha256: sha256Text('auto-split-sync-fail-context-0'),
            summary: 'first code failure'
        });
        appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:auto-split-code-1',
            review_context_sha256: sha256Text('auto-split-sync-fail-context-1'),
            summary: 'second code failure'
        });

        const result = resolveNextStep({ taskId, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'split-required-latch');
        assert.match(result.reason, /TASK\.md status sync failed/i);
        assert.match(result.reason, /Review cycle guard: BLOCK_FOR_OPERATOR_DECISION/i);
        assert.equal(result.review_cycle_block?.auto_split_enabled, true);
        const latch = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${taskId}-split-required.json`), 'utf8')) as Record<string, unknown>;
        assert.equal(latch.guard_kind, 'review_cycle');
        assert.deepEqual(latch.status_sync, {
            outcome: 'task_not_found',
            previous_status: null,
            next_status: 'SPLIT_REQUIRED',
            error_message: null
        });
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${taskId}.jsonl`), 'utf8');
        assert.equal(events.includes('"event_type":"SPLIT_REQUIRED_LATCHED"'), false);
    });

});

