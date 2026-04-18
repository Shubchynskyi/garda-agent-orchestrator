import test from 'node:test';
import assert from 'node:assert/strict';

import { parseTaskMdTableRow, replaceTaskMdTableCell } from '../../../src/core/task-md-table';

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
