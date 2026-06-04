import test from 'node:test';
import assert from 'node:assert/strict';

import { formatActiveTaskQueueTable, parseTaskMdTableRow, replaceTaskMdTableCell } from '../../../src/core/task-md-table';
import { buildTaskQueueStatusContract } from '../../../src/core/task-queue-status-contract';

test('parseTaskMdTableRow keeps escaped pipes inside a single cell', () => {
    const row = '| T-001 | TODO | P1 | area | title | me | 2026-01-01 | default | note with escaped \\| pipe |';
    const cells = parseTaskMdTableRow(row);

    assert.equal(cells.length, 9);
    assert.equal(cells[0].trimmed, 'T-001');
    assert.equal(cells[1].trimmed, 'TODO');
    assert.equal(cells[8].trimmed, 'note with escaped \\| pipe');
});

test('replaceTaskMdTableCell updates one cell without disturbing escaped pipes elsewhere', () => {
    const row = '| T-001 | TODO | P1 | area | title | me | 2026-01-01 | default | note with escaped \\| pipe |';
    const updated = replaceTaskMdTableCell(row, 1, ' DONE ');

    assert.equal(updated, '| T-001 | DONE | P1 | area | title | me | 2026-01-01 | default | note with escaped \\| pipe |');
});

test('formatActiveTaskQueueTable reflows only the canonical upper Active Queue table', () => {
    const content = [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-1 | 🟦 TODO | P1 | area | Short | me | 2026-06-04 | balanced | keep escaped \\| pipe |',
        '| T-2222 | 🟨 IN_PROGRESS | P2 | longer-area | Much longer title | agent | 2026-06-04 | strict | keep row order |',
        '',
        '## Блок очереди',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| RU-1 | untouched | P1 | ru | lower table | me | 2026-06-04 | balanced | stays compact |'
    ].join('\n');

    const formatted = formatActiveTaskQueueTable(content);

    assert.match(formatted, /\| T-1\s+\| 🟦 TODO\s+\| P1\s+\| area\s+\| Short\s+\| me\s+\| 2026-06-04 \| balanced \| keep escaped \\\| pipe \|/);
    assert.match(formatted, /\| T-2222 \| 🟨 IN_PROGRESS \| P2\s+\| longer-area \| Much longer title \| agent \| 2026-06-04 \| strict\s+\| keep row order\s+\|/);
    assert.ok(formatted.includes('## Блок очереди\n| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |'));
});

test('formatActiveTaskQueueTable leaves non-canonical tables unchanged', () => {
    const content = [
        '## Active Queue',
        '| ID | Status | Extra |',
        '|---|---|---|',
        '| T-001 | TODO | custom |'
    ].join('\n');

    assert.equal(formatActiveTaskQueueTable(content), content);
});

test('buildTaskQueueStatusContract blocks agent-authored lifecycle status edits but allows non-status content', () => {
    const contract = buildTaskQueueStatusContract('T-323');

    assert.equal(contract.decision, 'block');
    assert.equal(contract.authority, 'gate_owned_status_sync');
    assert.deepEqual(contract.gate_owned_statuses, ['IN_PROGRESS', 'IN_REVIEW', 'SPLIT_REQUIRED', 'DONE']);
    assert.deepEqual(contract.agent_blocked_statuses, ['IN_PROGRESS', 'IN_REVIEW', 'DONE', 'BLOCKED', 'SPLIT_REQUIRED']);
    assert.equal(contract.agent_may_edit_non_status_task_content, true);
    assert.equal(contract.operator_reset_command, 'gate task-reset --task-id "T-323" --reopen --dry-run --repo-root "."');
    assert.match(contract.reason, /instead of manually editing TASK\.md status cells/);
});
