import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initGitRepo } from '../git-fixtures';
import {
    assessProjectMemoryImpact,
    formatNextStepText,
    getWorkspaceSnapshot,
    recordFullSuiteValidationDuration,
    resolveNextStep
} from './next-step-test-support';
import { assertGateChainDecision } from '../../cli/commands/gate-test-gatechain';
import {
    TASK_ID,
    EXPECTED_LOOP_LINE,
    requireFromTest,
    NEXT_STEP_FULL_SUITE_TEST_CONFIG,
    ALL_REVIEW_FLAGS,
    tempRoots,
    PROVIDER_ENV_KEYS,
    withProviderEnv,
    makeTempRepo,
    reviewsRoot,
    eventsRoot,
    writeJson,
    writeJsonWithSha,
    writeProjectMemoryWorkflowConfig,
    seedProjectMemory,
    seedProjectMemoryImpact,
    sha256Text,
    fileSha256,
    writeNoOpEvidence,
    writeStrictDecompositionDecision,
    appendEvent,
    seedStartedTask,
    seedCustomStartedTask,
    seedTaskModeOnly,
    seedRulePack,
    seedHandshake,
    seedShellSmoke,
    seedPostPreflightRulePack,
    normalizeForTimeline,
    seedSplitRequiredLatchEvidence,
    getLoadedRuleFileBasenames,
    writePreflight,
    seedCompilePass,
    writeGitAutoPreflight,
    seedGitAutoCompilePass,
    buildReviewContextScopeFixture,
    writeReviewEvidence,
    markReviewEvidenceAsStrictReuse,
    writeStrictIndependentCodeReviewEvidence,
    writeReviewContextOnly,
    launchInputEvidenceFixture,
    seedCompletedReviewerLaunchAndInvocation,
    readReviewContextTreeStateSha256,
    writeFreshReviewContextWithoutRouting,
    seedReviewGatePass,
    seedDocImpactPass,
    seedCompletionPass,
    seedFullSuiteValidation,
    materializeFinalCloseout,
    seedCompletedTaskWithIndependentCodeReview,
    seedSourceCheckoutRuntime
} from './next-step-completion-fixtures';

describe('gates/next-step', () => {
    it('routes to project-memory-impact before completion when project memory maintenance is enabled', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'check' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'project-memory-impact');

        assert.equal(result.project_memory?.required, true);

        assert.equal(result.project_memory?.evidence_status, 'MISSING');

        assert.ok(result.commands[0].command.includes('gate project-memory-impact'));

        assert.ok(result.commands[0].command.includes('--preflight-path'));

        assert.ok(!result.commands[0].command.includes('gate completion-gate'));

    });



    it('continues to completion after current project-memory-impact evidence exists', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'check' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedProjectMemoryImpact(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'completion-gate', result.reason);

        assert.equal(result.project_memory?.evidence_status, 'CURRENT');

        assert.equal(result.project_memory?.status, 'NO_UPDATE_NEEDED');

        assert.ok(result.commands[0].command.includes('gate completion-gate'));

    });



    it('prints a project-memory confirmation command when missing evidence already has known affected files', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'update' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        const changedFiles = ['src/gates/project-memory-impact.ts'];

        const impactedSourcePath = path.join(repoRoot, changedFiles[0]);

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles });

        seedCompilePass(repoRoot, TASK_ID, undefined, changedFiles);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'project-memory-impact');

        assert.equal(result.project_memory?.evidence_status, 'MISSING');

        assert.equal(result.project_memory?.update_needed, true);

        assert.match(result.commands[0].command, /--mode "update"/);

        assert.match(result.commands[0].command, /--confirm-updated/);

        assert.match(result.commands[0].command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

        assert.match(result.commands[0].command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/compact\.md"/);

        assert.match(result.commands[0].command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/decisions\.md"/);

        assert.match(result.commands[0].command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/risks\.md"/);

    });



    it('prints a ready-to-run project-memory confirmation command when current evidence is blocked', () => {

        const repoRoot = makeTempRepo();

        writeProjectMemoryWorkflowConfig(repoRoot, { enabled: true, mode: 'strict' });

        seedProjectMemory(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        const impactedSourcePath = path.join(repoRoot, 'src', 'gates', 'project-memory-impact.ts');

        fs.mkdirSync(path.dirname(impactedSourcePath), { recursive: true });

        fs.writeFileSync(impactedSourcePath, 'export const impacted = true;\n', 'utf8');

        const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);

        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/gates/project-memory-impact.ts']);

        writeJson(preflightPath, {

            task_id: TASK_ID,

            detection_source: snapshot.detection_source,

            mode: 'FULL_PATH',

            scope_category: 'code',

            metrics: {

                changed_lines_total: snapshot.changed_lines_total,

                changed_files_sha256: snapshot.changed_files_sha256,

                scope_content_sha256: snapshot.scope_content_sha256,

                scope_sha256: snapshot.scope_sha256

            },

            required_reviews: { ...ALL_REVIEW_FLAGS },

            changed_files: ['src/gates/project-memory-impact.ts'],

            review_execution_policy: {

                mode: 'strict_sequential',

                visible_summary_line: 'Review execution policy: strict_sequential'

            }

        });

        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {

            output_path: normalizeForTimeline(preflightPath)

        });

        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`), {

            timestamp_utc: new Date().toISOString(),

            task_id: TASK_ID,

            event_source: 'compile-gate',

            status: 'PASSED',

            outcome: 'PASS',

            preflight_path: preflightPath.replace(/\\/g, '/'),

            preflight_hash_sha256: fileSha256(preflightPath),

            scope_detection_source: snapshot.detection_source,

            scope_include_untracked: snapshot.include_untracked,

            scope_changed_files: snapshot.changed_files,

            scope_changed_files_count: snapshot.changed_files_count,

            scope_changed_lines_total: snapshot.changed_lines_total,

            scope_changed_files_sha256: snapshot.changed_files_sha256,

            scope_content_sha256: snapshot.scope_content_sha256,

            scope_sha256: snapshot.scope_sha256

        });

        appendEvent(repoRoot, TASK_ID, 'COMPILE_GATE_PASSED', 'PASS');

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        const impact = assessProjectMemoryImpact({ repoRoot, taskId: TASK_ID, preflightPath });

        writeJson(impact.artifactPath, impact.artifact);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.next_gate, 'project-memory-impact');

        assert.equal(result.project_memory?.evidence_status, 'BLOCKED');

        assert.match(result.commands[0].command, /--mode "strict"/);

        assert.match(result.commands[0].command, /--preflight-path /);

        assert.match(result.commands[0].command, /--confirm-updated/);

        assert.match(result.commands[0].command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/commands\.md"/);

        assert.match(result.commands[0].command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/compact\.md"/);

        assert.match(result.commands[0].command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/decisions\.md"/);

        assert.match(result.commands[0].command, /--updated-memory-file "garda-agent-orchestrator\/live\/docs\/project-memory\/risks\.md"/);

    });



});
