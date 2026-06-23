import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initGitRepo } from '../git-fixtures';
import { formatNextStepText, resolveNextStep, recordFullSuiteValidationDuration } from './next-step-test-support';
import { assertGateChainDecision } from '../../cli/commands/gate-test-gatechain';
import {
    buildForcedSourceCheckoutRuntimeBuildCommand
} from '../../../../src/validators/workspace-layout';
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
    const expectedSourceRuntimeRebuildCommand = buildForcedSourceCheckoutRuntimeBuildCommand();

    it('routes completed tasks to task-audit-summary until final closeout is materialized', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'READY');

        assert.equal(result.next_gate, 'task-audit-summary');

        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));

        assert.match(result.reason, /final closeout artifacts are not materialized/i);

        assert.deepEqual(

            result.missing_artifacts.map((artifact) => artifact.key),

            ['final-closeout-json', 'final-closeout-markdown', 'final-user-report']

        );

    });



    it('reports final closeout artifacts when source runtime remediation wraps completed tasks', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        seedSourceCheckoutRuntime(repoRoot, true);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'source-runtime-remediation');

        assert.equal(result.commands[0].command, expectedSourceRuntimeRebuildCommand);

        assert.ok(result.reason.includes("intended gate 'task-audit-summary'"));

        assert.ok(result.reason.includes('gate task-audit-summary'));

        assert.deepEqual(

            result.missing_artifacts.map((artifact) => artifact.key),

            ['final-closeout-json', 'final-closeout-markdown', 'final-user-report']

        );

    });



    it('keeps current completed DONE rows ready for task-audit-summary until final closeout is materialized', () => {

        const repoRoot = makeTempRepo();

        const taskId = 'T-624';

        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [

            '# TASK.md',

            '',

            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',

            '|---|---|---|---|---|---|---|---|---|',

            '| T-624 | 🟩 DONE | P1 | workflow | Closed task | gpt-5.4 | 2026-05-05 | strict | Completion gate updated the queue row before final closeout. |',

            ''

        ].join('\n'), 'utf8');

        seedStartedTask(repoRoot, taskId);

        writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, taskId);

        seedReviewGatePass(repoRoot, taskId);

        seedDocImpactPass(repoRoot, taskId);

        seedCompletionPass(repoRoot, taskId);



        const result = resolveNextStep({ taskId, repoRoot });



        assert.equal(result.status, 'READY');

        assert.equal(result.next_gate, 'task-audit-summary');

        assert.equal(result.final_report, null);

        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));

        assert.match(result.reason, /final closeout artifacts are not materialized/i);

    });



    it('surfaces final report order and commit guidance after final closeout is materialized', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'DONE', result.reason);

        assert.equal(result.next_gate, null);

        assert.deepEqual(result.missing_artifacts, []);

        assert.equal(result.commands.length, 0);

        assert.equal(result.task_queue_status_contract.agent_may_edit_non_status_task_content, true);

        assert.equal(result.final_report?.required_order.length, 4);

        assert.ok(result.final_report?.final_user_report_path.endsWith(`${TASK_ID}-final-user-report.md`));

        const finalUserReportPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-final-user-report.md`);
        const finalUserReportBody = fs.readFileSync(finalUserReportPath, 'utf8');
        assert.equal(result.final_report?.final_user_report_body, finalUserReportBody);
        assert.equal(result.final_report?.final_user_report_sha256, sha256Text(finalUserReportBody));

        assert.ok((result.final_report?.commit_command_suggestion || '').startsWith('git commit -m "'));

        assert.match(result.reason, /canonical final closeout is materialized/i);

        assert.ok(text.includes('Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/SPLIT_REQUIRED/DONE'));

        assert.ok(text.includes('FinalUserReportPath:'));

        assert.ok(text.includes(`CopyPasteFinalUserReportSha256: ${sha256Text(finalUserReportBody)}`));

        assert.ok(text.includes(`CopyPasteFinalUserReport:\n${finalUserReportBody}`));

        assert.equal(text.includes('EndCopyPasteFinalUserReport'), false);

        assert.equal(text.includes('```'), false);

        assert.ok(text.includes('FinalUserReportInstruction: write a short summary of what you did, then paste CopyPasteFinalUserReport exactly as printed, without code fences, wrappers, paraphrase, interpretation, summarization, or reformatting; after that, present only the commit command and commit permission question listed in FinalReportOrder.'));

        assert.ok(text.includes('FinalReportOrder:'));

        assert.ok(text.includes('1. short agent-authored summary of what changed'));

        assert.ok(text.includes('2. verbatim Garda final user report'));

        assert.ok(text.includes('3. git commit -m "'));

        assert.ok(text.includes('4. Do you want me to commit now? (yes/no)'));

        assert.ok(text.includes('Commands:'));

        assert.ok(text.includes('  none'));

    });



    it('surfaces no-commit final report guidance after final closeout is materialized on a clean tracked worktree', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'DONE', result.reason);

        assert.equal(result.next_gate, null);

        assert.equal(result.commands.length, 0);

        assert.deepEqual(result.final_report?.required_order, [

            'short agent-authored summary of what changed',

            'verbatim Garda final user report'

        ]);

        assert.equal(result.final_report?.commit_command_suggestion, 'No commit required: no committable changes are present.');

        assert.equal(result.final_report?.commit_question, 'No commit confirmation required.');

        assert.ok(text.includes('FinalUserReportPath:'));

        assert.ok(!text.includes('3. No commit required: no committable changes are present.'));

        assert.ok(!text.includes('git commit -m "'));

        assert.ok(!text.includes('Do you want me to commit now? (yes/no)'));

    });



    it('surfaces final report readiness after independent review attestation and canonical materialization', () => {

        const repoRoot = makeTempRepo();

        seedCompletedTaskWithIndependentCodeReview(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'DONE', result.reason);

        assert.equal(result.next_gate, null);

        assert.equal(result.commands.length, 0);

        assert.equal(result.final_report?.required_order[0], 'short agent-authored summary of what changed');

        assert.equal(result.final_report?.required_order[1], 'verbatim Garda final user report');

        assert.ok(result.final_report?.required_order[2].startsWith('git commit -m "'));

        assert.equal(result.final_report?.required_order[3], 'Do you want me to commit now? (yes/no)');

        assert.ok((result.final_report?.commit_command_suggestion || '').startsWith('git commit -m "'));

        assert.match(result.reason, /canonical final closeout is materialized/i);

        assert.ok(text.includes('Review trust: INDEPENDENT_AUDITED via DELEGATED_SUBAGENT; independent reviewer launch attested.'));

        assert.ok(text.includes('1. short agent-authored summary of what changed'));

        assert.ok(text.includes('2. verbatim Garda final user report'));

        assert.ok(text.includes('3. git commit -m "'));

        assert.ok(text.includes('4. Do you want me to commit now? (yes/no)'));

        assert.ok(text.includes('Commands:'));

        assert.ok(text.includes('  none'));

    });



    it('routes back to task-audit-summary when final closeout artifacts are tampered or non-canonical', () => {

        for (const tamper of [

            'missing-json-attestation',

            'forged-json-attestation',

            'forged-json-commit-guidance',

            'reformatted-json',

            'forged-markdown',

            'missing-markdown-final-newline',

            'extra-markdown-trailing-blank',

            'missing-final-user-report',

            'forged-final-user-report'

        ]) {

            const repoRoot = makeTempRepo();

            seedStartedTask(repoRoot, TASK_ID);

            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

            seedCompilePass(repoRoot, TASK_ID);

            seedReviewGatePass(repoRoot, TASK_ID);

            seedDocImpactPass(repoRoot, TASK_ID);

            seedCompletionPass(repoRoot, TASK_ID);

            materializeFinalCloseout(repoRoot, TASK_ID);

            const closeoutRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');

            const closeoutPath = path.join(closeoutRoot, `${TASK_ID}-final-closeout.json`);

            const closeoutMarkdownPath = path.join(closeoutRoot, `${TASK_ID}-final-closeout.md`);

            const finalUserReportPath = path.join(closeoutRoot, `${TASK_ID}-final-user-report.md`);

            const closeout = JSON.parse(fs.readFileSync(closeoutPath, 'utf8')) as Record<string, unknown>;

            if (tamper === 'missing-json-attestation') {

                delete closeout.review_integrity_attestation; writeJson(closeoutPath, closeout);

            } else if (tamper === 'forged-json-attestation') {

                closeout.review_integrity_attestation = { ...(closeout.review_integrity_attestation as Record<string, unknown>), status: 'NO_REVIEW_REQUIRED', reason: 'forged no-review attestation' }; writeJson(closeoutPath, closeout);

            } else if (tamper === 'forged-json-commit-guidance') {

                closeout.commit_command_suggestion = 'git commit -m "forged: command"'; writeJson(closeoutPath, closeout);

            } else if (tamper === 'reformatted-json') {

                fs.writeFileSync(closeoutPath, JSON.stringify(closeout), 'utf8');

            } else if (tamper === 'missing-markdown-final-newline') {

                fs.writeFileSync(closeoutMarkdownPath, fs.readFileSync(closeoutMarkdownPath, 'utf8').trimEnd(), 'utf8');

            } else if (tamper === 'extra-markdown-trailing-blank') {

                fs.appendFileSync(closeoutMarkdownPath, '\n', 'utf8');

            } else if (tamper === 'missing-final-user-report') {

                fs.rmSync(finalUserReportPath, { force: true });

            } else if (tamper === 'forged-final-user-report') {

                fs.appendFileSync(finalUserReportPath, '\nforged review timing warning\n', 'utf8');

            } else {

                fs.writeFileSync(closeoutMarkdownPath, `${fs.readFileSync(closeoutMarkdownPath, 'utf8')}\nforged review integrity line\n`, 'utf8');

            }



            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



            assert.equal(result.status, 'READY', tamper);

            assert.equal(result.next_gate, 'task-audit-summary', tamper);

            assert.equal(result.final_report, null, tamper);

            assert.ok(result.commands[0].command.includes('gate task-audit-summary'), tamper);

            assert.match(result.reason, /final closeout artifacts are not materialized yet/i, tamper);

            assert.deepEqual(

                result.missing_artifacts.map((artifact) => artifact.key),

                ['final-closeout-json', 'final-closeout-markdown', 'final-user-report'],

                tamper

            );

        }

    });



    it('routes back to task-audit-summary when only a stale prior-cycle closeout is materialized', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);



        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const nextValue = 2;\n', 'utf8');

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'READY');

        assert.equal(result.next_gate, 'task-audit-summary');

        assert.equal(result.final_report, null);

        assert.equal(result.commands.length, 1);

        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));

        assert.match(result.reason, /final closeout artifacts are not materialized yet/i);

        assert.deepEqual(

            result.missing_artifacts.map((artifact) => artifact.key),

            ['final-closeout-json', 'final-closeout-markdown', 'final-user-report']

        );

    });



    it('keeps completed tasks ready for task-audit-summary even when the workspace is clean after commit', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;

        preflight.detection_source = 'git_auto';

        preflight.changed_files = ['src/app.ts'];

        preflight.metrics = {

            changed_lines_total: 10

        };

        writeJson(preflightPath, preflight);

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'READY');

        assert.equal(result.next_gate, 'task-audit-summary');

        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));

        assert.match(result.reason, /final closeout artifacts are not materialized yet/i);

    });



    it('routes completed tasks to initial final closeout materialization despite tracked drift', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        fs.writeFileSync(path.join(repoRoot, 'src', 'post-done-drift.ts'), 'export const drift = true;\n', 'utf8');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'READY');

        assert.equal(result.next_gate, 'task-audit-summary');

        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));

        assert.match(result.reason, /final closeout artifacts are not materialized yet/i);

    });



    it('blocks completed tasks on tracked post-DONE drift without reopening lifecycle gates', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.writeFileSync(path.join(repoRoot, 'src', 'post-done-drift.ts'), 'export const drift = true;\n', 'utf8');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Tracked post-DONE workspace drift detected/);

        assert.match(result.reason, /src\/post-done-drift\.ts/);

        assert.match(result.reason, /Do not reopen stale lifecycle gates automatically/);

        assert.equal(text.includes('gate classify-change'), false);

        assert.equal(text.includes('gate compile-gate'), false);

        assert.equal(text.includes('gate full-suite-validation'), false);

    });



    it('blocks completed tasks on tracked same-path post-DONE implementation drift', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        const preflightPath = writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;

        const metrics = preflight.metrics as Record<string, unknown>;

        delete metrics.scope_sha256;

        writeJson(preflightPath, preflight);

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.writeFileSync(

            path.join(repoRoot, 'src', 'app.ts'),

            'export const value = 1;\nexport const completedValue = 3;\n',

            'utf8'

        );



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Tracked post-DONE workspace drift detected/);

        assert.match(result.reason, /src\/app\.ts/);

        assert.match(result.reason, /scope_content_sha256/);

        assert.equal(text.includes('gate classify-change'), false);

        assert.equal(text.includes('gate compile-gate'), false);

        assert.equal(text.includes('gate full-suite-validation'), false);

    });



    it('blocks completed tasks when post-DONE workspace inspection fails in a git worktree', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.mkdirSync(path.join(repoRoot, '.git'), { recursive: true });



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Unable to inspect tracked post-DONE workspace drift/);

    });



    it('allows completed task closeout when only ignored runtime artifacts changed after DONE', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.writeFileSync(

            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'ignored-local.tmp'),

            'local runtime evidence\n',

            'utf8'

        );



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'DONE', result.reason);

        assert.equal(result.next_gate, null);

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /canonical final closeout is materialized/i);

    });



    it('does not let an old completion pass hide a restarted task cycle', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {

            restarted: true

        });



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.notEqual(result.status, 'DONE');

        assert.equal(result.next_gate, 'load-rule-pack');

        assert.ok(result.reason.includes('latest TASK_MODE_ENTERED'));

    });

});
