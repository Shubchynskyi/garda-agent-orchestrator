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
                '| T-701 | 🟩 DONE | P3 | tests/large-suite | Split `large-suite.test.ts` fixtures | gpt-5.3-codex | 2026-06-01 | balanced | Already done. |'
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
        writeFile(path.join(tmpDir, 'src', 'small.ts'), 'export const small = true;\n');
        writeFile(path.join(tmpDir, 'tests', 'node', 'large-suite.test.ts'), makeLines(9, 'test line'));
        writeFile(path.join(tmpDir, 'garda-agent-orchestrator', 'src', 'ignored.ts'), makeLines(200, 'ignored'));

        const report = collectLargeModuleReport(tmpDir, { fileLimit: 5, declarationLimit: 5 });

        assert.equal(report.mode, 'REPORT_ONLY');
        assert.deepEqual(report.scanned_roots.sort(), ['src', 'tests']);
        assert.equal(report.summary.scanned_file_count, 3);
        assert.equal(report.top_source_files[0].relative_path, 'src/large-source.ts');
        assert.equal(report.top_source_files[0].todo_follow_up_exists, true);
        assert.equal(report.top_source_files[0].owner_tasks[0].task_id, 'T-700');
        assert.equal(report.top_test_files[0].relative_path, 'tests/node/large-suite.test.ts');
        assert.equal(report.top_test_files[0].todo_follow_up_exists, false);
        assert.equal(report.top_declarations[0].relative_path, 'src/large-source.ts');
        assert.equal(report.top_declarations[0].declaration_kind, 'function');
        assert.equal(report.top_declarations[0].declaration_name, 'largeFunction');
        assert.ok(report.top_declarations[0].line_count > report.top_declarations[1].line_count);
        assert.equal(
            report.top_source_files.some((entry) => entry.relative_path.includes('ignored.ts')),
            false
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
