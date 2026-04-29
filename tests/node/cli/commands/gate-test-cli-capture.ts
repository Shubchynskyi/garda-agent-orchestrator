/**
 * Test helpers: CLI output capture and async-error assertion.
 *
 * Extracted from gate-test-helpers.ts to isolate capture/assertion
 * utilities from repo bootstrapping and evidence seeding.
 * All exports are test-only.
 */

import assert from 'node:assert/strict';
import * as path from 'node:path';

import {
    runCliMainWithHandling
} from '../../../../src/cli/main';


export async function captureExpectedAsyncError(callback: () => Promise<void>): Promise<Error> {
    try {
        await callback();
    } catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    assert.fail('Expected command to throw an error.');
}

export async function runCliWithCapturedOutput(
    argv: readonly string[],
    options: { cwd?: string } = {}
): Promise<{ exitCode: number; logs: string[]; errors: string[] }> {
    const stripAnsi = (value: string): string => value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const logs: string[] = [];
    const errors: string[] = [];
    process.exitCode = 0;
    console.log = (...args: unknown[]) => {
        logs.push(stripAnsi(args.map((value) => String(value)).join(' ')));
    };
    console.error = (...args: unknown[]) => {
        errors.push(stripAnsi(args.map((value) => String(value)).join(' ')));
    };
    try {
        process.env.NO_COLOR = '1';
        delete process.env.FORCE_COLOR;
        process.chdir(path.resolve(options.cwd || '.'));
        await runCliMainWithHandling(Array.from(argv));
        return {
            exitCode: process.exitCode ?? 0,
            logs,
            errors
        };
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        if (previousNoColor === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = previousNoColor;
        }
        if (previousForceColor === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = previousForceColor;
        }
        process.chdir(previousCwd);
        process.exitCode = previousExitCode;
    }
}
