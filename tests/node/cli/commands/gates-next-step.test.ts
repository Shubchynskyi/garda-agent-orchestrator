import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    runCliMainWithHandling
} from '../../../../src/cli/main';
import {
    createTempRepo,
    runCliWithCapturedOutput
} from './gate-test-helpers';

async function runCliWithStdoutCapture(
    argv: readonly string[],
    options: { cwd?: string } = {}
): Promise<{ exitCode: number; stdout: string; errors: string[] }> {
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalConsoleError = console.error;
    let stdout = '';
    const errors: string[] = [];
    process.exitCode = 0;
    process.stdout.write = ((chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
        stdout += typeof chunk === 'string' ? chunk : chunk.toString();
        const resolvedCallback = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        if (resolvedCallback) {
            resolvedCallback();
        }
        return true;
    }) as typeof process.stdout.write;
    console.error = (...args: unknown[]) => {
        errors.push(args.map((value) => String(value)).join(' '));
    };
    try {
        process.chdir(path.resolve(options.cwd || '.'));
        await runCliMainWithHandling(Array.from(argv));
        return {
            exitCode: process.exitCode ?? 0,
            stdout,
            errors
        };
    } finally {
        process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
        console.error = originalConsoleError;
        process.chdir(previousCwd);
        process.exitCode = previousExitCode;
    }
}

describe('cli/commands/gates next-step', () => {
    it('prints dedicated help for the next-step gate', async () => {
        const result = await runCliWithCapturedOutput(['gate', 'next-step', '--help'], {
            cwd: path.join(path.resolve('.'), 'src', 'cli')
        });

        assert.equal(result.exitCode, 0);
        assert.equal(result.errors.length, 0);
        const output = result.logs.join('\n');
        assert.ok(output.includes('gate next-step'));
        assert.ok(output.includes('next-step "<task-id>"'));
        assert.ok(output.includes('--task-id "<task-id>"'));
        assert.ok(output.includes('--preflight-path'));
        assert.ok(output.includes('--as-json'));
        assert.ok(output.includes('--events-root'));
        assert.ok(output.includes('--reviews-root'));
    });

    it('prints JSON next-step output from the public gate command', async () => {
        const repoRoot = createTempRepo();
        try {
            const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(
                path.join(configDir, 'workflow-config.json'),
                JSON.stringify({
                    full_suite_validation: {
                        enabled: true,
                        command: 'npm test'
                    },
                    review_execution_policy: {
                        mode: 'code_first_optional'
                    }
                }, null, 2),
                'utf8'
            );

            const result = await runCliWithStdoutCapture([
                'gate',
                'next-step',
                '--task-id',
                'T-CLI-NEXT',
                '--as-json',
                '--repo-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            const payload = JSON.parse(result.stdout) as Record<string, unknown>;
            assert.equal(payload.task_id, 'T-CLI-NEXT');
            assert.equal(payload.next_gate, 'enter-task-mode');
            const fullSuite = payload.full_suite_validation as Record<string, unknown>;
            assert.equal(fullSuite.enabled, true);
            assert.equal(fullSuite.command, 'npm test');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('prints human-readable next-step output from the public gate command', async () => {
        const repoRoot = createTempRepo();
        try {
            const result = await runCliWithStdoutCapture([
                'gate',
                'next-step',
                '--task-id',
                'T-CLI-HUMAN',
                '--repo-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.ok(result.stdout.includes('GARDA_NEXT_STEP'));
            assert.ok(result.stdout.includes('Navigator:'));
            assert.ok(result.stdout.includes('NextGate: enter-task-mode'));
            assert.ok(result.stdout.includes('FullSuite:'));
            assert.ok(result.stdout.includes('Commands:'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts a positional task id for the gate next-step command', async () => {
        const repoRoot = createTempRepo();
        try {
            const result = await runCliWithStdoutCapture([
                'gate',
                'next-step',
                'T-CLI-POSITIONAL',
                '--repo-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.ok(result.stdout.includes('Task: T-CLI-POSITIONAL'));
            assert.ok(result.stdout.includes('NextGate: enter-task-mode'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('accepts the top-level next-step alias with a positional task id', async () => {
        const repoRoot = createTempRepo();
        try {
            const result = await runCliWithStdoutCapture([
                'next-step',
                'T-CLI-TOPLEVEL',
                '--target-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.ok(result.stdout.includes('Task: T-CLI-TOPLEVEL'));
            assert.ok(result.stdout.includes('NextGate: enter-task-mode'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('can infer the task id and reviews root from a preflight path', async () => {
        const repoRoot = createTempRepo();
        try {
            const preflightPath = path.join('garda-agent-orchestrator', 'runtime', 'reviews', 'T-CLI-PREFLIGHT-preflight.json');
            fs.mkdirSync(path.dirname(path.join(repoRoot, preflightPath)), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, preflightPath), JSON.stringify({ task_id: 'T-CLI-PREFLIGHT' }), 'utf8');

            const result = await runCliWithStdoutCapture([
                'gate',
                'next-step',
                '--preflight-path',
                preflightPath,
                '--repo-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.ok(result.stdout.includes('Task: T-CLI-PREFLIGHT'));
            assert.ok(result.stdout.includes('NextGate: enter-task-mode'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('uses the configured bundle name in generated commands', async () => {
        const repoRoot = createTempRepo();
        const previousBundleName = process.env.GARDA_BUNDLE_NAME;
        try {
            process.env.GARDA_BUNDLE_NAME = 'custom-orchestrator';
            fs.renameSync(
                path.join(repoRoot, 'garda-agent-orchestrator'),
                path.join(repoRoot, 'custom-orchestrator')
            );
            const result = await runCliWithStdoutCapture([
                'gate',
                'next-step',
                '--task-id',
                'T-CUSTOM-BUNDLE',
                '--repo-root',
                '.'
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0);
            assert.equal(result.errors.length, 0);
            assert.ok(result.stdout.includes('node custom-orchestrator/bin/garda.js gate enter-task-mode'));
        } finally {
            if (previousBundleName === undefined) {
                delete process.env.GARDA_BUNDLE_NAME;
            } else {
                process.env.GARDA_BUNDLE_NAME = previousBundleName;
            }
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
