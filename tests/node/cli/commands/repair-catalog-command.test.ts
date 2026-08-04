import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleRepair } from '../../../../src/cli/commands/repair-command';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.2.0-test' };
const TASK_ID = 'T-2100-1';

function createWorkspace(): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-catalog-cli-'));
    fs.writeFileSync(path.join(workspaceRoot, 'MANIFEST.md'), '# Test bundle\n', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'VERSION'), '1.2.0-test\n', 'utf8');
    fs.writeFileSync(path.join(workspaceRoot, 'TASK.md'), [
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P1 | runtime/catalog | Catalog CLI | agent | 2026-08-03 | balanced | Test. |`,
        ''
    ].join('\n'), 'utf8');
    fs.mkdirSync(path.join(workspaceRoot, 'runtime', 'task-events'), { recursive: true });
    appendTaskEvent(
        workspaceRoot,
        TASK_ID,
        'TASK_MODE_ENTERED',
        'PASS',
        'Task mode entered.',
        {},
        { passThru: true, lowNoiseRuntimeWrites: true }
    );
    return workspaceRoot;
}

function invokeJson(workspaceRoot: string, action: string, confirm = false): Record<string, unknown> {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.map(String).join(' '));
    try {
        handleRepair([
            'catalog',
            action,
            '--target-root',
            workspaceRoot,
            '--json',
            ...(confirm ? ['--confirm'] : [])
        ], PACKAGE_JSON);
    } finally {
        console.log = originalLog;
    }
    return JSON.parse(output.join('\n')) as Record<string, unknown>;
}

test('repair catalog commands expose read-only diagnostics and preview-first mutations', { concurrency: false }, () => {
    const workspaceRoot = createWorkspace();
    try {
        assert.equal(invokeJson(workspaceRoot, 'health').status, 'missing');
        assert.equal(invokeJson(workspaceRoot, 'repair').status, 'dry_run');
        assert.equal(invokeJson(workspaceRoot, 'repair', true).status, 'repaired');
        assert.equal(invokeJson(workspaceRoot, 'health').status, 'healthy');

        const taskPath = path.join(workspaceRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace('| TODO |', '| DONE |'),
            'utf8'
        );
        const drift = invokeJson(workspaceRoot, 'drift');
        assert.equal(drift.status, 'drifted');
        assert.deepEqual(drift.changedSources, ['TASK.md']);

        assert.equal(invokeJson(workspaceRoot, 'rebuild').status, 'dry_run');
        assert.equal(invokeJson(workspaceRoot, 'rebuild', true).status, 'rebuilt');
        assert.equal(invokeJson(workspaceRoot, 'health').status, 'healthy');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('repair catalog rejects unknown subcommands before mutation', () => {
    const workspaceRoot = createWorkspace();
    try {
        assert.throws(
            () => handleRepair(['catalog', 'erase', '--target-root', workspaceRoot, '--json'], PACKAGE_JSON),
            /Allowed values: health, drift, repair, rebuild/u
        );
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});
