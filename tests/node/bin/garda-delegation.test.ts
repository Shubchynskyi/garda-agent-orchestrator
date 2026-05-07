import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
    getDelegationExitCode,
    getDelegationForwardSignals
} from '../../../src/bin/garda';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function writeDelegationHarness(tempRoot: string): string {
    const harnessPath = path.join(tempRoot, 'delegate-harness.js');
    const compiledLauncherPath = path.resolve(__dirname, '../../../src/bin/garda.js');
    writeFile(harnessPath, `
const { delegateToLocalCli } = require(${JSON.stringify(compiledLauncherPath)});
delegateToLocalCli(process.argv[2], process.argv.slice(3)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`);
    return harnessPath;
}

function spawnHarness(
    harnessPath: string,
    childScriptPath: string,
    args: string[] = [],
    env: NodeJS.ProcessEnv = process.env
): childProcess.ChildProcess {
    return childProcess.spawn(process.execPath, [harnessPath, childScriptPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env
    });
}

function spawnHarnessSync(
    harnessPath: string,
    childScriptPath: string,
    args: string[] = [],
    env: NodeJS.ProcessEnv = process.env
): childProcess.SpawnSyncReturns<string> {
    return childProcess.spawnSync(process.execPath, [harnessPath, childScriptPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        env,
        timeout: 5000
    });
}

function waitForClose(child: childProcess.ChildProcess): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (status, signal) => {
            resolve({ status, signal });
        });
    });
}

function waitForStdout(child: childProcess.ChildProcess, expected: string): Promise<string> {
    return new Promise((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => {
            reject(new Error(`Timed out waiting for stdout: ${expected}`));
        }, 5000);
        child.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString('utf8');
            if (output.includes(expected)) {
                clearTimeout(timeout);
                resolve(output);
            }
        });
    });
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await delay(50);
    }
    return !isProcessAlive(pid);
}

test('delegation maps child exit codes and signals consistently', () => {
    assert.equal(getDelegationExitCode(0, null), 0);
    assert.equal(getDelegationExitCode(7, null), 7);
    assert.equal(getDelegationExitCode(null, 'SIGINT'), 130);
    assert.equal(getDelegationExitCode(null, 'SIGTERM'), 143);
    assert.equal(getDelegationExitCode(null, 'SIGBREAK'), 149);
    assert.equal(getDelegationExitCode(null, 'SIGKILL'), 137);
    assert.equal(getDelegationExitCode(null, null), 1);
});

test('delegation forwards platform-specific termination signals', () => {
    assert.deepEqual(getDelegationForwardSignals('linux'), ['SIGINT', 'SIGTERM']);
    assert.deepEqual(getDelegationForwardSignals('win32'), ['SIGINT', 'SIGTERM', 'SIGBREAK']);
});

test('delegation preserves child exit code', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-exit-'));
    try {
        const harnessPath = writeDelegationHarness(tempRoot);
        const childScriptPath = path.join(tempRoot, 'exit-code-child.js');
        writeFile(childScriptPath, 'process.exit(Number(process.argv[2]));\n');

        const result = spawnHarnessSync(harnessPath, childScriptPath, ['7']);

        assert.equal(result.status, 7);
        assert.equal(result.error, undefined);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation inherits child stdout and stderr', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-output-'));
    try {
        const harnessPath = writeDelegationHarness(tempRoot);
        const childScriptPath = path.join(tempRoot, 'output-child.js');
        writeFile(childScriptPath, `
process.stdout.write('delegated stdout\\n');
process.stderr.write('delegated stderr\\n');
process.exit(0);
`);

        const result = spawnHarnessSync(harnessPath, childScriptPath);

        assert.equal(result.status, 0);
        assert.match(result.stdout, /delegated stdout/);
        assert.match(result.stderr, /delegated stderr/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation timeout terminates the child process', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-timeout-'));
    try {
        const harnessPath = writeDelegationHarness(tempRoot);
        const pidPath = path.join(tempRoot, 'child.pid');
        const childScriptPath = path.join(tempRoot, 'timeout-child.js');
        writeFile(childScriptPath, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);

        const child = spawnHarness(harnessPath, childScriptPath, [], {
            ...process.env,
            GARDA_LAUNCHER_DELEGATION_TIMEOUT_MS: '1000'
        });
        let stderr = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString('utf8');
        });

        await waitForStdout(child, 'ready');
        const delegatedPid = Number(fs.readFileSync(pidPath, 'utf8'));
        const result = await waitForClose(child);

        assert.notEqual(result.status, 0);
        assert.match(stderr, /delegated CLI timed out after 1000ms/);
        assert.equal(await waitForProcessExit(delegatedPid), true);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('delegation forwards SIGTERM to the child on POSIX', {
    skip: process.platform === 'win32' ? 'POSIX signal handler semantics are not portable on Windows.' : false
}, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-delegation-signal-'));
    try {
        const harnessPath = writeDelegationHarness(tempRoot);
        const childScriptPath = path.join(tempRoot, 'signal-child.js');
        writeFile(childScriptPath, `
process.on('SIGTERM', () => {
  process.stdout.write('child-sigterm\\n');
  process.exit(42);
});
process.stdout.write('ready\\n');
setInterval(() => {}, 1000);
`);

        const child = spawnHarness(harnessPath, childScriptPath);
        let stdout = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        await waitForStdout(child, 'ready');

        child.kill('SIGTERM');
        const result = await waitForClose(child);

        assert.equal(result.status, 42);
        assert.equal(result.signal, null);
        assert.match(stdout, /child-sigterm/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
