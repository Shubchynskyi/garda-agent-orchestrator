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

// ---------------------------------------------------------------------------
// Capture / assertion helpers
// ---------------------------------------------------------------------------

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
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const logs: string[] = [];
    const errors: string[] = [];
    process.exitCode = 0;
    console.log = (...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(' '));
    };
    console.error = (...args: unknown[]) => {
        errors.push(args.map((value) => String(value)).join(' '));
    };
    try {
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
        process.chdir(previousCwd);
        process.exitCode = previousExitCode;
    }
}
