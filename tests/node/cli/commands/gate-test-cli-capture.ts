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

function isLikelyNodeTestReporterText(text: string): boolean {
    const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
    if (lines.length === 0) {
        return false;
    }
    return lines.every((line) =>
        /^(?:TAP version \d+|\s*(?:ok\b|not ok\b|\d+\.\.\d+|#\s|---|\.\.\.|[✔✖▶ℹ]|duration_ms:|type:|location:|failureType:|error:|code:|stack:|\|-))/u.test(line)
    );
}

function isLikelyBinaryNodeTestProtocolChunk(chunk: Buffer): boolean {
    for (const byte of chunk) {
        if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 27)) {
            return true;
        }
    }
    return false;
}

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
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const logs: string[] = [];
    const errors: string[] = [];
    process.exitCode = 0;
    console.log = (...args: unknown[]) => {
        logs.push(stripAnsi(args.map((value) => String(value)).join(' ')));
    };
    console.error = (...args: unknown[]) => {
        errors.push(stripAnsi(args.map((value) => String(value)).join(' ')));
    };
    process.stdout.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        if (Buffer.isBuffer(chunk) && isLikelyBinaryNodeTestProtocolChunk(chunk)) {
            originalStdoutWrite(chunk);
            if (typeof encoding === 'function') {
                encoding();
            }
            if (typeof callback === 'function') {
                callback();
            }
            return true;
        }
        const text = typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
                ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
                : String(chunk ?? '');
        if (isLikelyNodeTestReporterText(text)) {
            originalStdoutWrite(text);
        } else {
            stdoutChunks.push(stripAnsi(text));
        }
        if (typeof encoding === 'function') {
            encoding();
        }
        if (typeof callback === 'function') {
            callback();
        }
        return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        const text = typeof chunk === 'string'
            ? chunk
            : Buffer.isBuffer(chunk)
                ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8')
                : String(chunk ?? '');
        stderrChunks.push(stripAnsi(text));
        if (typeof encoding === 'function') {
            encoding();
        }
        if (typeof callback === 'function') {
            callback();
        }
        return true;
    }) as typeof process.stderr.write;
    try {
        process.env.NO_COLOR = '1';
        delete process.env.FORCE_COLOR;
        process.chdir(path.resolve(options.cwd || '.'));
        await runCliMainWithHandling(Array.from(argv));
        logs.push(...stdoutChunks.join('').split(/\r?\n/).filter((line) => line.length > 0));
        errors.push(...stderrChunks.join('').split(/\r?\n/).filter((line) => line.length > 0));
        return {
            exitCode: process.exitCode ?? 0,
            logs,
            errors
        };
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
        process.stderr.write = originalStderrWrite as typeof process.stderr.write;
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
