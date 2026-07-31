import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    materializeFullSuiteRepairTask
} from '../../../../src/gates/full-suite/full-suite-repair-task';
import {
    findFullSuiteRepairChildHandoffState
} from '../../../../src/gates/full-suite/full-suite-repair-decomposition';
import {
    resolveNextStep
} from '../../../../src/gates/next-step/next-step';
import {
    ALL_REVIEW_FLAGS,
    TASK_ID,
    appendEvent,
    eventsRoot,
    makeTempRepo,
    reviewsRoot,
    seedCompilePass,
    seedFullSuiteValidation,
    seedStartedTask,
    writeJson,
    writePreflight
} from './next-step-full-suite-fixtures';

function seedExhaustedTimeout(repoRoot: string): {
    preflightPath: string;
    fullSuitePath: string;
} {
    seedStartedTask(repoRoot, TASK_ID);
    writePreflight(repoRoot, TASK_ID, {
        ...ALL_REVIEW_FLAGS,
        code: true,
        test: true
    });
    seedCompilePass(repoRoot, TASK_ID);
    seedFullSuiteValidation(repoRoot, TASK_ID, 'FAILED');
    const preflightPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`);
    const fullSuitePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`);
    const fullSuiteArtifact = JSON.parse(fs.readFileSync(fullSuitePath, 'utf8')) as Record<string, unknown>;
    fullSuiteArtifact.timed_out = true;
    fullSuiteArtifact.timeout_policy = {
        timeout_blocker: true,
        timeout_retry_count: 1,
        max_attempts: 2,
        attempts: [
            { attempt: 1, exit_code: 1, timed_out: true },
            { attempt: 2, exit_code: 1, timed_out: true }
        ],
        attempts_exhausted: true,
        warning_only_continuation: false,
        repair_task_proposal: {
            suggested_task_id: `${TASK_ID}-F1`,
            title: 'Fix full-suite timeout blocker',
            area: 'workflow/full-suite-timeout',
            rationale: 'Full-suite validation timed out after configured retries.'
        }
    };
    writeJson(fullSuitePath, fullSuiteArtifact);
    appendEvent(repoRoot, TASK_ID, 'FULL_SUITE_VALIDATION_FAILED', 'FAIL', {
        timed_out: true,
        cycle_binding: fullSuiteArtifact.cycle_binding,
        timeout_policy: fullSuiteArtifact.timeout_policy
    });
    return { preflightPath, fullSuitePath };
}

function writeRepairDecomposition(repoRoot: string, childTaskIds: string[]): void {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const parentLinked = fs.readFileSync(taskPath, 'utf8')
        .split('\n')
        .map((line) => {
            if (!line.startsWith(`| ${TASK_ID} |`)) {
                return line;
            }
            const cells = line.split('|');
            cells[9] =
                ` Decomposition source: orchestrator (2026-06-30); child tasks: ${childTaskIds.map((taskId) => `\`${taskId}\``).join(', ')}. `;
            return cells.join('|');
        })
        .join('\n');
    const childRows = childTaskIds.map((childTaskId, index) => (
        `| ${childTaskId} | TODO | P1 | workflow/full-suite-timeout-${index === 0 ? 'diagnostics' : 'repair'} | ` +
        `${index === 0 ? 'Diagnose' : 'Repair'} timeout blocker | gpt-5.5 | 2026-06-30 | strict | Child of \`${TASK_ID}\`. |`
    ));
    fs.writeFileSync(taskPath, `${parentLinked}${childRows.join('\n')}\n`, 'utf8');
}

describe('next-step full-suite repair child handoff', () => {
    it('rejects direct child execution when a singular child is presented as a split', () => {
        const repoRoot = makeTempRepo();
        seedExhaustedTimeout(repoRoot);
        const childTaskId = `${TASK_ID}-F1`;
        writeRepairDecomposition(repoRoot, [childTaskId]);

        const result = resolveNextStep({ taskId: childTaskId, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'full-suite-repair-child-handoff');
        assert.match(result.reason, /at least two meaningful linked child tasks/);
        assert.ok(result.commands[0].command.includes(`next-step "${TASK_ID}"`));
    });

    it('blocks child handoff discovery through an external reviews junction', (t) => {
        const repoRoot = makeTempRepo();
        seedExhaustedTimeout(repoRoot);
        const childTaskIds = [`${TASK_ID}-F1`, `${TASK_ID}-F2`];
        writeRepairDecomposition(repoRoot, childTaskIds);
        const localReviewsRoot = reviewsRoot(repoRoot);
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-handoff-external-'));
        t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
        const externalReviewsRoot = path.join(externalRoot, 'reviews');
        fs.cpSync(localReviewsRoot, externalReviewsRoot, { recursive: true });
        fs.rmSync(localReviewsRoot, { recursive: true, force: true });
        fs.symlinkSync(externalReviewsRoot, localReviewsRoot, process.platform === 'win32' ? 'junction' : 'dir');

        const handoff = findFullSuiteRepairChildHandoffState(repoRoot, childTaskIds[0]);

        assert.equal(handoff?.decomposition.ready, false);
        assert.match(handoff?.decomposition.violations.join('\n') || '', /symbolic-link or junction/);
    });

    it('blocks direct child startup when the parent full-suite artifact is malformed', () => {
        const repoRoot = makeTempRepo();
        seedExhaustedTimeout(repoRoot);
        const childTaskIds = [`${TASK_ID}-F1`, `${TASK_ID}-F2`];
        writeRepairDecomposition(repoRoot, childTaskIds);
        fs.writeFileSync(
            path.join(reviewsRoot(repoRoot), `${TASK_ID}-full-suite-validation.json`),
            '{ malformed',
            'utf8'
        );

        const result = resolveNextStep({ taskId: childTaskIds[0], repoRoot });

        assert.equal(result.next_gate, 'full-suite-repair-child-handoff');
        assert.match(result.reason, /is not trusted/);
    });

    it('blocks direct child startup when durable repair evidence has no current full-suite artifact', () => {
        const repoRoot = makeTempRepo();
        const { fullSuitePath } = seedExhaustedTimeout(repoRoot);
        const childTaskIds = [`${TASK_ID}-F1`, `${TASK_ID}-F2`];
        writeRepairDecomposition(repoRoot, childTaskIds);
        fs.rmSync(fullSuitePath);

        const result = resolveNextStep({ taskId: childTaskIds[0], repoRoot });

        assert.equal(result.next_gate, 'full-suite-repair-child-handoff');
        assert.match(result.reason, /is missing despite durable timeout repair lifecycle evidence/);
    });

    it('uses the active events root when durable repair evidence has no current artifact', () => {
        const repoRoot = makeTempRepo();
        const { fullSuitePath } = seedExhaustedTimeout(repoRoot);
        const childTaskIds = [`${TASK_ID}-F1`, `${TASK_ID}-F2`];
        writeRepairDecomposition(repoRoot, childTaskIds);
        const defaultEventsRoot = eventsRoot(repoRoot);
        const customEventsRoot = path.join(repoRoot, 'custom-runtime', 'task-events');
        fs.mkdirSync(path.dirname(customEventsRoot), { recursive: true });
        fs.renameSync(defaultEventsRoot, customEventsRoot);
        fs.rmSync(fullSuitePath);

        const result = resolveNextStep({
            taskId: childTaskIds[0],
            repoRoot,
            eventsRoot: customEventsRoot
        });

        assert.equal(result.next_gate, 'full-suite-repair-child-handoff');
        assert.match(result.reason, /is missing despite durable timeout repair lifecycle evidence/);
    });

    it('blocks direct child startup when durable repair evidence has a valid altered timeout artifact', () => {
        const repoRoot = makeTempRepo();
        const { fullSuitePath } = seedExhaustedTimeout(repoRoot);
        const childTaskIds = [`${TASK_ID}-F1`, `${TASK_ID}-F2`];
        writeRepairDecomposition(repoRoot, childTaskIds);
        const fullSuiteArtifact = JSON.parse(fs.readFileSync(fullSuitePath, 'utf8')) as Record<string, unknown>;
        fullSuiteArtifact.timeout_policy = {
            timeout_blocker: false,
            attempts_exhausted: true,
            warning_only_continuation: true,
            repair_task_proposal: null
        };
        writeJson(fullSuitePath, fullSuiteArtifact);

        const result = resolveNextStep({ taskId: childTaskIds[0], repoRoot });

        assert.equal(result.next_gate, 'full-suite-repair-child-handoff');
        assert.match(result.reason, /no longer matches durable timeout repair lifecycle evidence/);
    });

    it('blocks direct child startup when the current repair artifact did not time out', () => {
        const repoRoot = makeTempRepo();
        const { fullSuitePath } = seedExhaustedTimeout(repoRoot);
        const childTaskIds = [`${TASK_ID}-F1`, `${TASK_ID}-F2`];
        writeRepairDecomposition(repoRoot, childTaskIds);
        const fullSuiteArtifact = JSON.parse(fs.readFileSync(fullSuitePath, 'utf8')) as Record<string, unknown>;
        fullSuiteArtifact.timed_out = false;
        writeJson(fullSuitePath, fullSuiteArtifact);

        const result = resolveNextStep({ taskId: childTaskIds[0], repoRoot });

        assert.equal(result.next_gate, 'full-suite-repair-child-handoff');
        assert.match(result.reason, /no longer matches durable timeout repair lifecycle evidence/);
    });

    it('uses the active reviews root for repair child handoff discovery', () => {
        const repoRoot = makeTempRepo();
        seedExhaustedTimeout(repoRoot);
        const childTaskIds = [`${TASK_ID}-F1`, `${TASK_ID}-F2`];
        writeRepairDecomposition(repoRoot, childTaskIds);
        const defaultReviewsRoot = reviewsRoot(repoRoot);
        const customReviewsRoot = path.join(repoRoot, 'custom-runtime', 'reviews');
        fs.mkdirSync(path.dirname(customReviewsRoot), { recursive: true });
        fs.renameSync(defaultReviewsRoot, customReviewsRoot);

        const beforeMaterialization = resolveNextStep({
            taskId: childTaskIds[0],
            repoRoot,
            reviewsRoot: customReviewsRoot
        });
        assert.equal(beforeMaterialization.next_gate, 'full-suite-repair-child-handoff');
        assert.match(beforeMaterialization.reason, /materialization artifact is missing/);
    });

    it('allows child task startup only after the multi-child handoff is materialized', () => {
        const repoRoot = makeTempRepo();
        const { preflightPath, fullSuitePath } = seedExhaustedTimeout(repoRoot);
        const childTaskIds = [`${TASK_ID}-F1`, `${TASK_ID}-F2`];
        writeRepairDecomposition(repoRoot, childTaskIds);

        const beforeMaterialization = resolveNextStep({ taskId: childTaskIds[0], repoRoot });
        assert.equal(beforeMaterialization.next_gate, 'full-suite-repair-child-handoff');
        assert.match(beforeMaterialization.reason, /materialization artifact is missing/);

        const materialized = materializeFullSuiteRepairTask({
            repoRoot,
            taskId: TASK_ID,
            preflightPath,
            fullSuiteArtifactPath: fullSuitePath
        });
        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        assert.deepEqual(materialized.child_task_ids, childTaskIds);

        const afterMaterialization = resolveNextStep({ taskId: childTaskIds[0], repoRoot });
        assert.notEqual(afterMaterialization.next_gate, 'full-suite-repair-child-handoff');
        assert.equal(afterMaterialization.next_gate, 'enter-task-mode');

        const taskPath = path.join(repoRoot, 'TASK.md');
        const firstChildDone = fs.readFileSync(taskPath, 'utf8')
            .split('\n')
            .map((line) => line.startsWith(`| ${childTaskIds[0]} |`)
                ? line.replace('| TODO |', '| DONE |')
                : line)
            .join('\n');
        fs.writeFileSync(taskPath, firstChildDone, 'utf8');

        const remainingChild = resolveNextStep({ taskId: childTaskIds[1], repoRoot });
        assert.notEqual(remainingChild.next_gate, 'full-suite-repair-child-handoff');
        assert.equal(remainingChild.next_gate, 'enter-task-mode');
    });
});
