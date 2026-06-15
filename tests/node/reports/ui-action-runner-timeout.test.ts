import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    UI_ACTION_DEFAULT_TIMEOUT_MS,
    formatUiActionTimeoutMessage,
    runUiActionCommand
} from '../../../src/reports/ui/actions/action-common';
import { buildUiWorkspaceActionDefinitions } from '../../../src/reports/ui/actions/workspace-actions';
import type { UiActionDefinition } from '../../../src/reports/ui/actions/types';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-ui-action-timeout-'));
}

test('runUiActionCommand reports timeout and kills the subprocess tree', async () => {
    const repoRoot = makeTmpDir();
    try {
        const markerPath = path.join(repoRoot, 'child-survived.txt');
        const childScript = [
            `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'alive'), 1200);`,
            'setTimeout(() => {}, 10000);'
        ].join('');
        const parentScript = [
            'const childProcess = require("node:child_process");',
            `childProcess.spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
            'setTimeout(() => {}, 10000);'
        ].join('');
        const action: UiActionDefinition = {
            id: 'timeout-regression',
            category: 'Test',
            label: 'Timeout Regression',
            description: 'Exercise local UI action timeout cleanup.',
            mutates: false,
            enabled: true,
            unavailable_reason: null,
            requires_confirmation: false,
            confirmation_phrase: null,
            timeout_ms: 250,
            command: {
                executable: process.execPath,
                args: ['-e', parentScript],
                display: 'node -e <timeout-regression>'
            }
        };

        const result = await runUiActionCommand(action, repoRoot);
        await delay(1800);

        assert.equal(result.timed_out, true);
        assert.equal(result.timeout_ms, 250);
        assert.notEqual(result.exit_code, 0);
        assert.match(result.stderr, /Process timed out after 250 ms/u);
        assert.match(result.stderr, new RegExp(formatUiActionTimeoutMessage(250).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
        assert.equal(fs.existsSync(markerPath), false, 'child process should not survive UI action timeout cleanup');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('workspace UI actions only expose visible switch controls with default timeout budgets', () => {
    const repoRoot = makeTmpDir();
    try {
        const actions = buildUiWorkspaceActionDefinitions(repoRoot);
        const actionIds = actions.map((action) => action.id).sort();

        assert.deepEqual(actionIds, ['garda-off', 'garda-on']);
        assert.ok(actions.every((action) => action.timeout_ms === UI_ACTION_DEFAULT_TIMEOUT_MS));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('runUiActionCommand uses the UI allowlisted environment instead of inheriting parent secrets', async () => {
    const repoRoot = makeTmpDir();
    const secretEnvKey = 'GARDA_UI_ACTION_SECRET_REGRESSION';
    const previousSecret = process.env[secretEnvKey];
    try {
        process.env[secretEnvKey] = 'must-not-leak';
        const action: UiActionDefinition = {
            id: 'env-regression',
            category: 'Test',
            label: 'Env Regression',
            description: 'Verify local UI action subprocess env isolation.',
            mutates: false,
            enabled: true,
            unavailable_reason: null,
            requires_confirmation: false,
            confirmation_phrase: null,
            timeout_ms: 5_000,
            command: {
                executable: process.execPath,
                args: ['-e', `process.stdout.write(process.env.${secretEnvKey} || 'missing')`],
                display: 'node -e <env-regression>'
            }
        };

        const result = await runUiActionCommand(action, repoRoot);

        assert.equal(result.exit_code, 0);
        assert.equal(result.timed_out, false);
        assert.equal(result.stdout, 'missing');
    } finally {
        if (previousSecret === undefined) {
            delete process.env[secretEnvKey];
        } else {
            process.env[secretEnvKey] = previousSecret;
        }
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
