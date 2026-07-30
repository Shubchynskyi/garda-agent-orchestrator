import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, type TestContext } from 'node:test';

import {
    CLI_TEST_TEMP_OWNER_FILE,
    CliTestTempManager,
    createManagedTestTempDirectory,
    removeTempRepoWithRetry
} from './gate-test-temp-manager';

function createSandbox(t: TestContext): string {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-temp-manager-test-'));
    t.after(() => {
        removeTempRepoWithRetry(sandbox);
    });
    return sandbox;
}

function writeOwner(
    runRoot: string,
    processId: number,
    hostname: string,
    createdAtUtc = '2026-07-28T00:00:00.000Z'
): void {
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(
        path.join(runRoot, CLI_TEST_TEMP_OWNER_FILE),
        `${JSON.stringify({
            schema_version: 1,
            process_id: processId,
            hostname,
            created_at_utc: createdAtUtc
        }, null, 2)}\n`,
        'utf8'
    );
}

describe('CLI test temp manager', { concurrency: false }, () => {
    it('groups allocations under one marked run root and binds explicit t.after cleanup', (t) => {
        const baseRoot = createSandbox(t);
        const manager = new CliTestTempManager({
            baseRoot,
            processId: 41001,
            hostname: 'test-host',
            isProcessAlive: () => true
        });
        const registeredCleanups: Array<() => void> = [];
        const directory = manager.createDirectory('repo-', {
            after(callback) {
                registeredCleanups.push(callback);
            }
        });
        const runRoot = path.dirname(directory);

        assert.equal(path.dirname(runRoot), baseRoot);
        assert.ok(path.basename(runRoot).startsWith('run-'));
        assert.ok(fs.existsSync(path.join(runRoot, CLI_TEST_TEMP_OWNER_FILE)));
        assert.equal(registeredCleanups.length, 1);

        registeredCleanups[0]();
        assert.equal(fs.existsSync(directory), false);
        manager.cleanupRunRoot();
        assert.equal(fs.existsSync(runRoot), false);
    });

    it('reclaims a marked run root whose local owner process is dead', (t) => {
        const baseRoot = createSandbox(t);
        const staleRoot = path.join(baseRoot, 'run-stale');
        writeOwner(staleRoot, 41002, 'test-host');
        const manager = new CliTestTempManager({
            baseRoot,
            processId: 41003,
            hostname: 'test-host',
            isProcessAlive: () => false
        });

        manager.createDirectory('repo-');

        assert.equal(fs.existsSync(staleRoot), false);
        manager.cleanupRunRoot();
    });

    it('keeps run-scoped shared fixtures until final run-root cleanup', (t) => {
        const baseRoot = createSandbox(t);
        const manager = new CliTestTempManager({
            baseRoot,
            processId: 41007,
            hostname: 'test-host',
            isProcessAlive: () => true
        });
        const sharedDirectory = manager.createRunScopedDirectory('fixture-');
        const caseDirectory = manager.createDirectory('repo-');
        const runRoot = path.dirname(sharedDirectory);

        manager.cleanupTrackedDirectories();

        assert.equal(fs.existsSync(caseDirectory), false);
        assert.equal(fs.existsSync(sharedDirectory), true);
        manager.cleanupRunRoot();
        assert.equal(fs.existsSync(runRoot), false);
    });

    it('does not reclaim a run root whose local owner process is alive', (t) => {
        const baseRoot = createSandbox(t);
        const activeRoot = path.join(baseRoot, 'run-active');
        writeOwner(activeRoot, 41004, 'test-host');
        const manager = new CliTestTempManager({
            baseRoot,
            processId: 41005,
            hostname: 'test-host',
            isProcessAlive: (processId) => processId === 41004
        });

        manager.createDirectory('repo-');

        assert.equal(fs.existsSync(activeRoot), true);
        manager.cleanupRunRoot();
    });

    it('surfaces cleanup failures instead of forgetting the tracked directory', (t) => {
        const baseRoot = createSandbox(t);
        const cleanupError = Object.assign(new Error('fixture handle is still open'), { code: 'EBUSY' });
        const manager = new CliTestTempManager({
            baseRoot,
            processId: 41006,
            hostname: 'test-host',
            isProcessAlive: () => true,
            removeDirectory: () => {
                throw cleanupError;
            }
        });
        const directory = manager.createDirectory('repo-');

        assert.throws(
            () => manager.cleanupTrackedDirectories(),
            (error: unknown) => error === cleanupError
        );
        assert.equal(fs.existsSync(directory), true);
    });

    it('cleans a helper-created directory when the test assertion fails', (t) => {
        const sandbox = createSandbox(t);
        const childTestPath = path.join(sandbox, 'assertion-failure.test.cjs');
        const markerPath = path.join(sandbox, 'allocated-path.txt');
        const compiledManagerPath = path.join(__dirname, 'gate-test-temp-manager.js');
        fs.writeFileSync(childTestPath, [
            "const assert = require('node:assert/strict');",
            "const fs = require('node:fs');",
            "const { it } = require('node:test');",
            `const { createManagedTestTempDirectory } = require(${JSON.stringify(compiledManagerPath)});`,
            `const markerPath = ${JSON.stringify(markerPath)};`,
            "it('intentional assertion failure', () => {",
            "  const directory = createManagedTestTempDirectory('failed-');",
            "  fs.writeFileSync(markerPath, directory, 'utf8');",
            "  assert.fail('intentional assertion failure');",
            '});'
        ].join('\n'), 'utf8');

        const childEnv: NodeJS.ProcessEnv = { ...process.env };
        delete childEnv.NODE_TEST_CONTEXT;
        const result = childProcess.spawnSync(process.execPath, ['--test', childTestPath], {
            encoding: 'utf8',
            env: childEnv,
            windowsHide: true
        });
        assert.ok(
            fs.existsSync(markerPath),
            `Child test did not record its allocation.\n${result.stdout}\n${result.stderr}`
        );
        const allocatedDirectory = fs.readFileSync(markerPath, 'utf8').trim();

        assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
        assert.equal(fs.existsSync(allocatedDirectory), false);
    });
});

let previousSharedDirectory = '';

describe('shared CLI test temp lifecycle hooks', { concurrency: false }, () => {
    it('tracks a helper-created directory for automatic afterEach cleanup', () => {
        previousSharedDirectory = createManagedTestTempDirectory('hook-');
        assert.ok(fs.existsSync(previousSharedDirectory));
    });

    it('has removed the directory left by the preceding test body', () => {
        assert.notEqual(previousSharedDirectory, '');
        assert.equal(fs.existsSync(previousSharedDirectory), false);
    });
});
