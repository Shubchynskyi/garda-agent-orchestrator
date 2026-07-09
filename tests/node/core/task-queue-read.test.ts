import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    parseTaskQueueEntriesFromContent,
    readTaskQueueEntries
} from '../../../src/core/task-queue-read';

function taskQueueContent(): string {
    return [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-100 | IN_PROGRESS | P1 | core/helpers | Centralize helpers | codex | 2026-07-09 | strict | child tasks: T-100-1 |',
        '| not a task | TODO | P2 | misc | Ignored row | codex | 2026-07-09 | balanced | invalid id |',
        ''
    ].join('\n');
}

test('parseTaskQueueEntriesFromContent preserves canonical TASK.md queue parsing fields', () => {
    const entries = parseTaskQueueEntriesFromContent(taskQueueContent());

    assert.deepEqual([...entries.keys()], ['T-100']);
    assert.deepEqual(entries.get('T-100'), {
        taskId: 'T-100',
        status: 'IN_PROGRESS',
        area: 'core/helpers',
        title: 'Centralize helpers',
        profile: 'strict',
        notes: 'child tasks: T-100-1'
    });
});

test('readTaskQueueEntries returns an empty map for missing TASK.md by default', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-queue-read-missing-'));
    try {
        assert.equal(readTaskQueueEntries(repoRoot).size, 0);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('readTaskQueueEntries can preserve callers that expect missing TASK.md to throw', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-queue-read-throw-'));
    try {
        assert.throws(
            () => readTaskQueueEntries(repoRoot, { missingFile: 'throw' }),
            /TASK\.md/
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('readTaskQueueEntries reads TASK.md from the repo root', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-queue-read-'));
    try {
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), taskQueueContent(), 'utf8');

        assert.equal(readTaskQueueEntries(repoRoot).get('T-100')?.title, 'Centralize helpers');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
