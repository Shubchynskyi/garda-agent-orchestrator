import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';
import {
    buildTaskAuditSummary,
    formatNextStepText,
    readReadyFinalReportSummary,
    resolveNextStep,
    synchronizeFinalCloseoutArtifacts
} from './next-step-test-support';
import {
    buildForcedSourceCheckoutRuntimeBuildCommand
} from '../../../../src/validators/workspace-layout';
import {
    TASK_ID,
    ALL_REVIEW_FLAGS,
    makeTempRepo,
    reviewsRoot,
    writeJson,
    sha256Text,
    appendEvent,
    seedStartedTask,
    writePreflight,
    seedCompilePass,
    writeGitAutoPreflight,
    seedGitAutoCompilePass,
    writeStagedPreflight,
    seedStagedCompilePass,
    seedReviewGatePass,
    seedDocImpactPass,
    seedCompletionPass,
    materializeFinalCloseout,
    seedCompletedTaskWithIndependentCodeReview,
    seedSourceCheckoutRuntime
} from './next-step-completion-fixtures';

function bindProtectedDirtyBaseline(
    preflightPath: string,
    relativePath: string,
    contentSha256: string
): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    preflight.triggers = {
        dirty_workspace_protection_status: 'PASS',
        dirty_workspace_untouched_baseline_files: [relativePath],
        dirty_workspace_protected_files: [relativePath],
        dirty_workspace_protected_files_sha256: sha256Text(relativePath),
        dirty_workspace_protected_file_hashes: {
            [relativePath]: contentSha256
        }
    };
    writeJson(preflightPath, preflight);
}

function captureGitCommands<T>(callback: () => T): { result: T; gitCommands: string[][] } {
    const childProcessModule = require('node:child_process') as typeof import('node:child_process');
    const originalSpawnSync = childProcessModule.spawnSync;
    const originalExecFileSync = childProcessModule.execFileSync;
    const gitCommands: string[][] = [];
    childProcessModule.spawnSync = ((command: string, args: string[], options: unknown) => {
        if (command === 'git') gitCommands.push([...args]);
        return originalSpawnSync(command, args, options as never);
    }) as typeof originalSpawnSync;
    childProcessModule.execFileSync = ((command: string, args: string[], options: unknown) => {
        if (command === 'git') gitCommands.push([...args]);
        return originalExecFileSync(command, args, options as never);
    }) as typeof originalExecFileSync;
    try {
        return { result: callback(), gitCommands };
    } finally {
        childProcessModule.spawnSync = originalSpawnSync;
        childProcessModule.execFileSync = originalExecFileSync;
    }
}

function seedCompletedTaskWithProtectedDirtyBaseline(
    repoRoot: string
): { baselinePath: string; preflightPath: string } {
    const baselineRelativePath = 'src/local-baseline.ts';
    const baselinePath = path.join(repoRoot, baselineRelativePath);
    fs.writeFileSync(baselinePath, 'export const localBaseline = 1;\n', 'utf8');
    initGitRepo(repoRoot);
    fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');
    fs.writeFileSync(baselinePath, 'export const localBaseline = 2;\n', 'utf8');
    seedStartedTask(repoRoot, TASK_ID);
    const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
    bindProtectedDirtyBaseline(
        preflightPath,
        baselineRelativePath,
        sha256Text(fs.readFileSync(baselinePath, 'utf8'))
    );
    seedCompilePass(repoRoot, TASK_ID);
    seedReviewGatePass(repoRoot, TASK_ID);
    seedDocImpactPass(repoRoot, TASK_ID);
    seedCompletionPass(repoRoot, TASK_ID);
    materializeFinalCloseout(repoRoot, TASK_ID);
    return { baselinePath, preflightPath };
}

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



    it('rejects non-canonical final closeout artifacts and routes a representative tamper back to task-audit-summary', () => {

        const repoRoot = makeTempRepo();

        seedStartedTask(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        const summary = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });

        synchronizeFinalCloseoutArtifacts(summary);

        const closeoutRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');

        const closeoutPath = path.join(closeoutRoot, `${TASK_ID}-final-closeout.json`);

        const closeoutMarkdownPath = path.join(closeoutRoot, `${TASK_ID}-final-closeout.md`);

        const finalUserReportPath = path.join(closeoutRoot, `${TASK_ID}-final-user-report.md`);

        const canonicalCloseout = fs.readFileSync(closeoutPath);

        const canonicalCloseoutMarkdown = fs.readFileSync(closeoutMarkdownPath);

        const canonicalFinalUserReport = fs.readFileSync(finalUserReportPath);

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

            fs.writeFileSync(closeoutPath, canonicalCloseout);

            fs.writeFileSync(closeoutMarkdownPath, canonicalCloseoutMarkdown);

            fs.writeFileSync(finalUserReportPath, canonicalFinalUserReport);

            const closeout = JSON.parse(canonicalCloseout.toString('utf8')) as Record<string, unknown>;

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



            assert.equal(
                readReadyFinalReportSummary(repoRoot, closeoutRoot, TASK_ID, summary),
                null,
                tamper
            );

            if (tamper !== 'forged-markdown') {
                continue;
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



        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'READY', formatNextStepText(result));

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

    it('keeps a materialized completed task DONE after its exact audited diff is committed', () => {
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
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        runGitFixtureCommand(repoRoot, ['commit', '-m', 'commit completed scope']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'DONE', result.reason);
        assert.equal(result.next_gate, null);
        assert.equal(result.commands.length, 0);
    });

    it('blocks a materialized completed task when committed audited content no longer matches', () => {
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
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        runGitFixtureCommand(repoRoot, ['commit', '-m', 'commit completed scope']);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const laterValue = 3;\n', 'utf8');
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        runGitFixtureCommand(repoRoot, ['commit', '-m', 'change completed scope later']);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'post-done-drift');
        assert.match(result.reason, /scope_content_sha256/);
    });

    it('blocks a materialized completed task when an audited scope hash is missing', () => {
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
        const closeoutPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-final-closeout.json`);
        const closeout = JSON.parse(fs.readFileSync(closeoutPath, 'utf8')) as Record<string, unknown>;
        delete (closeout.implementation_summary as Record<string, unknown>).scope_content_sha256;
        writeJson(closeoutPath, closeout);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'post-done-drift');
        assert.match(result.reason, /missing valid audited scope hashes/);
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



    it('filters only a hash-identical authenticated dirty baseline after DONE', () => {

        const repoRoot = makeTempRepo();

        const fixture = seedCompletedTaskWithProtectedDirtyBaseline(repoRoot);



        const unchangedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(unchangedResult.status, 'DONE', unchangedResult.reason);

        assert.equal(unchangedResult.next_gate, null);

        assert.doesNotMatch(unchangedResult.reason, /post-DONE workspace drift/i);

        fs.appendFileSync(fixture.baselinePath, 'export const postDoneDrift = 3;\n', 'utf8');
        const changedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(changedResult.next_gate, 'post-done-drift');
        assert.match(changedResult.reason, /src\/local-baseline\.ts/);

        fs.writeFileSync(fixture.baselinePath, 'export const localBaseline = 1;\n', 'utf8');
        const restoredToHeadResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(restoredToHeadResult.next_gate, 'post-done-drift');
        assert.match(restoredToHeadResult.reason, /src\/local-baseline\.ts/);

        fs.writeFileSync(fixture.baselinePath, 'export const localBaseline = 2;\n', 'utf8');
        fs.unlinkSync(fixture.baselinePath);
        const deletedBaselineResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(deletedBaselineResult.next_gate, 'post-done-drift');
        assert.match(deletedBaselineResult.reason, /src\/local-baseline\.ts/);

        fs.writeFileSync(fixture.baselinePath, 'export const localBaseline = 2;\n', 'utf8');
        const preflight = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.detection_source = 'git_staged_only';
        preflight.include_untracked = false;
        writeJson(fixture.preflightPath, preflight);
        const newUntrackedPath = path.join(repoRoot, 'src', 'post-done-untracked.ts');
        fs.writeFileSync(newUntrackedPath, 'export const postDoneUntracked = true;\n', 'utf8');
        const newUntrackedResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(newUntrackedResult.next_gate, 'post-done-drift');
        assert.match(newUntrackedResult.reason, /src\/post-done-untracked\.ts/);

        fs.unlinkSync(newUntrackedPath);
        const preflightWithMissingHash = JSON.parse(fs.readFileSync(fixture.preflightPath, 'utf8')) as Record<string, unknown>;
        const triggers = preflightWithMissingHash.triggers as Record<string, unknown>;
        triggers.dirty_workspace_protected_files = ['src/local-baseline.ts', 'src/deleted-untracked.ts'];
        triggers.dirty_workspace_protected_file_hashes = {
            'src/local-baseline.ts': sha256Text(fs.readFileSync(fixture.baselinePath, 'utf8'))
        };
        writeJson(fixture.preflightPath, preflightWithMissingHash);
        const missingHashResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingHashResult.next_gate, 'post-done-drift');
        assert.match(missingHashResult.reason, /src\/deleted-untracked\.ts/);

        bindProtectedDirtyBaseline(
            fixture.preflightPath,
            'src/local-baseline.ts',
            sha256Text(fs.readFileSync(fixture.baselinePath, 'utf8'))
        );
        const preflightWithMalformedScopeHash = JSON.parse(
            fs.readFileSync(fixture.preflightPath, 'utf8')
        ) as Record<string, unknown>;
        (preflightWithMalformedScopeHash.triggers as Record<string, unknown>)
            .dirty_workspace_protected_files_sha256 = 'malformed';
        writeJson(fixture.preflightPath, preflightWithMalformedScopeHash);
        const malformedScopeHashResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(malformedScopeHashResult.next_gate, 'post-done-drift');
        assert.match(malformedScopeHashResult.reason, /src\/local-baseline\.ts/);

        bindProtectedDirtyBaseline(fixture.preflightPath, 'src/local-baseline.ts', 'malformed');
        const malformedHashResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(malformedHashResult.next_gate, 'post-done-drift');
        assert.match(malformedHashResult.reason, /src\/local-baseline\.ts/);

        bindProtectedDirtyBaseline(
            fixture.preflightPath,
            'src/local-baseline.ts',
            sha256Text(fs.readFileSync(fixture.baselinePath, 'utf8'))
        );
        const preflightWithEmptyProtectedScope = JSON.parse(
            fs.readFileSync(fixture.preflightPath, 'utf8')
        ) as Record<string, unknown>;
        (preflightWithEmptyProtectedScope.triggers as Record<string, unknown>)
            .dirty_workspace_protected_files = [];
        writeJson(fixture.preflightPath, preflightWithEmptyProtectedScope);
        const emptyProtectedScopeResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(emptyProtectedScopeResult.next_gate, 'post-done-drift');
        assert.match(emptyProtectedScopeResult.reason, /protected-baseline authentication failed/i);

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



        const { result, gitCommands } = captureGitCommands(() => (
            resolveNextStep({ taskId: TASK_ID, repoRoot })
        ));

        const text = formatNextStepText(result);



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Post-DONE workspace drift detected/);

        assert.match(result.reason, /src\/post-done-drift\.ts/);

        assert.match(result.reason, /Do not reopen stale lifecycle gates automatically/);

        assert.equal(text.includes('gate classify-change'), false);

        assert.equal(text.includes('gate compile-gate'), false);

        assert.equal(text.includes('gate full-suite-validation'), false);

        const gitAutoNumstatCommands = gitCommands.filter((args) => (
            args.includes('--numstat') && !args.includes('--')
        ));

        assert.equal(gitAutoNumstatCommands.length, 1);

    });

    it('blocks completed tasks on staged-only post-DONE drift without reopening lifecycle gates', () => {

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

        fs.writeFileSync(path.join(repoRoot, 'src', 'post-done-staged.ts'), 'export const stagedDrift = true;\n', 'utf8');

        runGitFixtureCommand(repoRoot, ['add', 'src/post-done-staged.ts']);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Post-DONE workspace drift detected/);

        assert.match(result.reason, /src\/post-done-staged\.ts/);

        assert.match(result.reason, /Commit or isolate the already-completed task diff/);

        assert.equal(text.includes('gate classify-change'), false);

        assert.equal(text.includes('gate compile-gate'), false);

        assert.equal(text.includes('gate full-suite-validation'), false);

    });

    it('allows completed staged-scope closeout after the staged diff is committed', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);

        seedStartedTask(repoRoot, TASK_ID);

        writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedStagedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        runGitFixtureCommand(repoRoot, ['commit', '-m', 'complete staged task']);



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'DONE', result.reason);

        assert.equal(result.next_gate, null);

        assert.match(result.reason, /canonical final closeout is materialized/i);

        assert.doesNotMatch(result.reason, /post-DONE workspace drift/i);

    });

    it('blocks completed staged-scope closeout on same-path worktree drift after DONE', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);

        seedStartedTask(repoRoot, TASK_ID);

        writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedStagedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        seedDocImpactPass(repoRoot, TASK_ID);

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        runGitFixtureCommand(repoRoot, ['commit', '-m', 'complete staged task']);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const postDoneDrift = 3;\n', 'utf8');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.match(result.reason, /Tracked post-DONE workspace drift/);

        assert.match(result.reason, /src\/app\.ts/);

    });

    it('blocks completed staged-scope closeout on doc-impact audited drift after DONE', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);

        seedStartedTask(repoRoot, TASK_ID);

        writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedStagedCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });

        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI\n\nDocumented closeout.\n', 'utf8');

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`), {
            task_id: TASK_ID,
            decision: 'DOCS_UPDATED',
            status: 'PASSED',
            outcome: 'PASS',
            docs_updated: ['docs/cli-reference.md'],
            behavior_changed: false,
            changelog_updated: false
        });

        appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED');

        seedCompletionPass(repoRoot, TASK_ID);

        materializeFinalCloseout(repoRoot, TASK_ID);

        fs.appendFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '\nPost-DONE drift.\n', 'utf8');



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.match(result.reason, /changed audited closeout extra scope/);

        assert.match(result.reason, /docs\/cli-reference\.md/);

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

        fs.rmSync(path.join(repoRoot, '.git'), { recursive: true, force: true });
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
