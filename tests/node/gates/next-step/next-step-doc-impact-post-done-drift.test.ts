import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initGitRepo } from '../git-fixtures';
import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import {
    TASK_ID,
    ALL_REVIEW_FLAGS,
    makeTempRepo,
    reviewsRoot,
    writeJson,
    appendEvent,
    seedStartedTask,
    writeGitAutoPreflight,
    seedGitAutoCompilePass,
    seedReviewGatePass,
    seedCompletionPass,
    materializeFinalCloseout} from './next-step-doc-impact-fixtures';

describe('gates/next-step', () => {
    it('blocks completed tasks on tracked post-DONE drift in doc-impact audited files', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

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

        const text = formatNextStepText(result);



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Tracked post-DONE workspace drift detected in audited completed scope/);

        assert.match(result.reason, /docs\/cli-reference\.md/);

        assert.match(result.reason, /audited scope_content_sha256/);

        assert.equal(text.includes('gate classify-change'), false);

        assert.equal(text.includes('gate compile-gate'), false);

        assert.equal(text.includes('gate full-suite-validation'), false);

    });



    it('blocks completed tasks when post-DONE doc-impact artifact changes audited files in a clean worktree', () => {

        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const completedValue = 2;\n', 'utf8');

        seedStartedTask(repoRoot, TASK_ID);

        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        seedGitAutoCompilePass(repoRoot, TASK_ID);

        seedReviewGatePass(repoRoot, TASK_ID);

        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });

        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI\n\nDocumented closeout.\n', 'utf8');

        fs.writeFileSync(path.join(repoRoot, 'docs', 'extra.md'), '# Extra\n\nTracked but not audited.\n', 'utf8');

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

        execFileSync('git', ['add', 'src/app.ts', 'docs/cli-reference.md', 'docs/extra.md'], { cwd: repoRoot, stdio: 'ignore' });

        execFileSync('git', ['commit', '-m', 'complete task'], { cwd: repoRoot, stdio: 'ignore' });

        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`), {

            task_id: TASK_ID,

            decision: 'DOCS_UPDATED',

            status: 'PASSED',

            outcome: 'PASS',

            docs_updated: ['docs/cli-reference.md', 'docs/extra.md'],

            behavior_changed: false,

            changelog_updated: false

        });



        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        const text = formatNextStepText(result);



        assert.equal(result.status, 'BLOCKED');

        assert.equal(result.next_gate, 'post-done-drift');

        assert.equal(result.commands.length, 0);

        assert.match(result.reason, /Tracked post-DONE workspace drift detected in audited completed scope/);

        assert.match(result.reason, /docs\/extra\.md/);

        assert.equal(text.includes('gate task-audit-summary'), false);

        assert.equal(text.includes('gate classify-change'), false);

        assert.equal(text.includes('gate compile-gate'), false);

        assert.equal(text.includes('gate full-suite-validation'), false);

    });

});
