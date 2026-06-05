import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { collectLargeModuleReport } from '../../../src/validators/large-module-report';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function makeLines(count: number, prefix: string): string {
    return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';
}

test('collectLargeModuleReport ranks source, test, and declaration size with task follow-up hints', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-module-report-'));
    try {
        writeFile(
            path.join(tmpDir, 'TASK.md'),
            [
                '| ID | Status | Priority | Area | Title | Model | Date | Profile | Notes |',
                '| T-700 | 🟦 TODO | P2 | refactor/large-source | Decompose `src/large-source.ts` responsibilities | gpt-5.3-codex | 2026-06-01 | balanced | Follow-up for `large-source.ts`. |',
                '| T-701 | 🟩 DONE | P3 | tests/large-suite | Split `large-suite.test.ts` fixtures | gpt-5.3-codex | 2026-06-01 | balanced | Already done. |',
                '| T-702 | 🟦 TODO | P2 | refactor/next-step-size-budget | Keep `src/gates/next-step/next-step.ts` and next-step helpers within budget | gpt-5.3-codex | 2026-06-01 | balanced | Follow-up for `next-step.ts`. |'
            ].join('\n') + '\n'
        );
        writeFile(
            path.join(tmpDir, 'src', 'large-source.ts'),
            [
                'export function largeFunction(): void {',
                makeLines(12, '    doWork();').trimEnd(),
                '}',
                '',
                'export class SmallerThing {',
                '    run(): void {}',
                '}'
            ].join('\n') + '\n'
        );
        writeFile(path.join(tmpDir, 'src', 'gates', 'next-step', 'next-step.ts'), makeLines(11, 'navigator line'));
        writeFile(path.join(tmpDir, 'src', 'gates', 'next-step', 'next-step-example-helper.ts'), makeLines(8, 'helper line'));
        writeFile(path.join(tmpDir, 'src', 'small.ts'), 'export const small = true;\n');
        writeFile(path.join(tmpDir, 'tests', 'node', 'large-suite.test.ts'), makeLines(9, 'test line'));
        writeFile(path.join(tmpDir, 'garda-agent-orchestrator', 'src', 'ignored.ts'), makeLines(200, 'ignored'));

        const report = collectLargeModuleReport(tmpDir, { fileLimit: 5, declarationLimit: 5 });

        assert.equal(report.mode, 'REPORT_ONLY');
        assert.deepEqual(report.scanned_roots.sort(), ['src', 'tests']);
        assert.equal(report.summary.scanned_file_count, 5);
        assert.equal(report.top_source_files[0].relative_path, 'src/large-source.ts');
        assert.equal(report.top_source_files[0].todo_follow_up_exists, true);
        assert.equal(report.top_source_files[0].owner_tasks[0].task_id, 'T-700');
        assert.equal(report.top_test_files[0].relative_path, 'tests/node/large-suite.test.ts');
        assert.equal(report.top_test_files[0].todo_follow_up_exists, false);
        assert.equal(report.top_declarations[0].relative_path, 'src/large-source.ts');
        assert.equal(report.top_declarations[0].declaration_kind, 'function');
        assert.equal(report.top_declarations[0].declaration_name, 'largeFunction');
        assert.ok(report.top_declarations[0].line_count > report.top_declarations[1].line_count);
        assert.equal(report.next_step_module_budget.mode, 'REPORT_ONLY');
        assert.equal(report.next_step_module_budget.status, 'WITHIN_BUDGET');
        assert.equal(report.next_step_module_budget.total_module_count, 2);
        assert.equal(report.next_step_module_budget.total_lines, 19);
        assert.equal(report.next_step_module_budget.largest_helper_lines, 8);
        assert.equal(report.next_step_module_budget.modules[0].relative_path, 'src/gates/next-step/next-step.ts');
        assert.equal(report.next_step_module_budget.modules[0].role, 'coordinator');
        assert.equal(report.next_step_module_budget.modules[0].line_budget, 4500);
        assert.equal(report.next_step_module_budget.modules[0].responsibility, 'public navigator coordinator and result assembly');
        assert.equal(report.next_step_module_budget.modules[0].todo_follow_up_exists, true);
        assert.equal(report.next_step_module_budget.modules[1].role, 'helper');
        assert.equal(report.next_step_module_budget.modules[1].line_budget, 700);
        assert.equal(report.next_step_module_budget.modules[1].responsibility, 'next-step helper: example helper');
        assert.equal(
            report.top_source_files.some((entry) => entry.relative_path.includes('ignored.ts')),
            false
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectLargeModuleReport marks over-budget next-step modules with diagnostic exception reason', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-module-report-'));
    try {
        writeFile(
            path.join(tmpDir, 'TASK.md'),
            [
                '| ID | Status | Priority | Area | Title | Model | Date | Profile | Notes |',
                '| T-725-4 | 🟦 TODO | P3 | workflow/next-step-review-artifact-reader-split | Split review artifact reader | gpt-5.5 | 2026-06-05 | balanced | Follow-up for `src/gates/next-step/next-step-review-artifact-readers.ts`. |'
            ].join('\n') + '\n'
        );
        writeFile(
            path.join(tmpDir, 'src', 'gates', 'next-step', 'next-step.ts'),
            makeLines(4501, 'coordinator line')
        );
        writeFile(
            path.join(tmpDir, 'src', 'gates', 'next-step', 'next-step-review-artifact-readers.ts'),
            makeLines(702, 'known helper line')
        );
        writeFile(
            path.join(tmpDir, 'src', 'gates', 'next-step', 'next-step-review-evidence.ts'),
            makeLines(703, 'missing follow-up helper line')
        );
        writeFile(
            path.join(tmpDir, 'src', 'gates', 'next-step', 'next-step-broad-helper.ts'),
            makeLines(701, 'helper line')
        );

        const report = collectLargeModuleReport(tmpDir, { fileLimit: 5, declarationLimit: 5 });
        const modules = new Map(
            report.next_step_module_budget.modules.map((entry) => [entry.relative_path, entry])
        );
        const expectedReason = 'Report-only budget exception: keep a concrete decomposition follow-up before raising this diagnostic threshold.';

        assert.equal(report.next_step_module_budget.status, 'OVER_BUDGET');
        assert.equal(report.next_step_module_budget.over_budget_count, 4);
        assert.equal(modules.get('src/gates/next-step/next-step.ts')?.line_budget, 4500);
        assert.equal(modules.get('src/gates/next-step/next-step.ts')?.budget_status, 'OVER_BUDGET');
        assert.equal(modules.get('src/gates/next-step/next-step.ts')?.exception_reason, expectedReason);
        assert.equal(modules.get('src/gates/next-step/next-step-review-artifact-readers.ts')?.line_budget, 700);
        assert.equal(modules.get('src/gates/next-step/next-step-review-artifact-readers.ts')?.budget_status, 'OVER_BUDGET');
        assert.deepEqual(modules.get('src/gates/next-step/next-step-review-artifact-readers.ts')?.owner_tasks, [{
            task_id: 'T-725-4',
            status: '🟦 TODO',
            title: 'Split review artifact reader'
        }]);
        assert.equal(modules.get('src/gates/next-step/next-step-review-artifact-readers.ts')?.todo_follow_up_exists, true);
        assert.equal(
            modules.get('src/gates/next-step/next-step-review-artifact-readers.ts')?.exception_reason,
            'Report-only budget exception: tracked by T-725-4; keep this helper visible until the decomposition follow-up completes.'
        );
        assert.equal(modules.get('src/gates/next-step/next-step-review-evidence.ts')?.budget_status, 'OVER_BUDGET');
        assert.equal(modules.get('src/gates/next-step/next-step-review-evidence.ts')?.owner_tasks.length, 0);
        assert.equal(modules.get('src/gates/next-step/next-step-review-evidence.ts')?.todo_follow_up_exists, false);
        assert.equal(
            modules.get('src/gates/next-step/next-step-review-evidence.ts')?.exception_reason,
            'Report-only budget exception: expected follow-up T-725-2 is missing from TASK.md; keep this helper visible until the queue row exists or the helper is split.'
        );
        assert.equal(modules.get('src/gates/next-step/next-step-broad-helper.ts')?.line_budget, 700);
        assert.equal(modules.get('src/gates/next-step/next-step-broad-helper.ts')?.budget_status, 'OVER_BUDGET');
        assert.equal(modules.get('src/gates/next-step/next-step-broad-helper.ts')?.exception_reason, expectedReason);
        assert.equal(modules.get('src/gates/next-step/next-step-broad-helper.ts')?.todo_follow_up_exists, false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectLargeModuleReport accepts all T-725 next-step helper follow-up rows together', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'large-module-report-'));
    try {
        const helperFollowUps = [
            {
                taskId: 'T-725-1',
                title: 'Split next-step compile and full-suite readiness helper',
                relativePath: 'src/gates/next-step/next-step-compile-full-suite-readiness.ts'
            },
            {
                taskId: 'T-725-2',
                title: 'Split next-step review evidence helper',
                relativePath: 'src/gates/next-step/next-step-review-evidence.ts'
            },
            {
                taskId: 'T-725-3',
                title: 'Split next-step task queue transition helper',
                relativePath: 'src/gates/next-step/next-step-task-queue-transitions.ts'
            },
            {
                taskId: 'T-725-4',
                title: 'Split next-step review artifact reader helper',
                relativePath: 'src/gates/next-step/next-step-review-artifact-readers.ts'
            }
        ];
        writeFile(
            path.join(tmpDir, 'TASK.md'),
            [
                '| ID | Status | Priority | Area | Title | Model | Date | Profile | Notes |',
                ...helperFollowUps.map((followUp) =>
                    `| ${followUp.taskId} | 🟦 TODO | P3 | workflow/next-step-helper-split | ${followUp.title} | gpt-5.5 | 2026-06-05 | balanced | Follow-up for \`${followUp.relativePath}\`. |`
                )
            ].join('\n') + '\n'
        );
        for (const followUp of helperFollowUps) {
            writeFile(path.join(tmpDir, followUp.relativePath), makeLines(701, 'tracked helper line'));
        }

        const report = collectLargeModuleReport(tmpDir, { fileLimit: 10, declarationLimit: 5 });
        const modules = new Map(
            report.next_step_module_budget.modules.map((entry) => [entry.relative_path, entry])
        );

        assert.equal(report.next_step_module_budget.status, 'OVER_BUDGET');
        assert.equal(report.next_step_module_budget.over_budget_count, helperFollowUps.length);
        for (const followUp of helperFollowUps) {
            const moduleEntry = modules.get(followUp.relativePath);
            assert.equal(moduleEntry?.budget_status, 'OVER_BUDGET');
            assert.deepEqual(moduleEntry?.owner_tasks, [{
                task_id: followUp.taskId,
                status: '🟦 TODO',
                title: followUp.title
            }]);
            assert.equal(moduleEntry?.todo_follow_up_exists, true);
            assert.equal(
                moduleEntry?.exception_reason,
                `Report-only budget exception: tracked by ${followUp.taskId}; keep this helper visible until the decomposition follow-up completes.`
            );
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
