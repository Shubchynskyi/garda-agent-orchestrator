import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../../../../src/cli/exit-codes';
import {
    runIntermediateCommandCommand
} from '../../../../../../src/cli/commands/gates';

import {
    createTempRepo,
    getOrchestratorRoot,
    readTaskTimelineEvents,
    seedInitAnswers,
    seedTaskQueue
} from '../../gate-test-helpers';

function seedNodeFoundationFocusedWrapperFixture(repoRoot: string): void {
    const scriptPath = path.join(repoRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');
    const testPath = path.join(repoRoot, 'tests', 'node', 'gates', 'focused-command.test.ts');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.writeFileSync(testPath, 'export {};\n', 'utf8');
    fs.writeFileSync(
        scriptPath,
        [
            "if (process.argv[2] !== 'test.js') process.exit(2);",
            "console.log('node-foundation focused wrapper executed');",
            ''
        ].join('\n'),
        'utf8'
    );
}

describe('cli/commands/gates intermediate command wrapper', () => {
    it('runs intermediate commands with compact audited output telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
            fs.writeFileSync(
                path.join(repoRoot, 'tests', 'intermediate-pass.test.js'),
                [
                    "const test = require('node:test');",
                    "for (let index = 0; index < 80; index += 1) {",
                    "  test(`VISIBLE_RAW_LINE_ONE verbose intermediate output line ${index} with enough padding to make compaction measurable`, () => {});",
                    "}",
                    "test('ACCESS_TOKEN=secret-value', () => {",
                    "  for (let index = 0; index < 40; index += 1) {",
                    "    console.log(`verbose intermediate output line ${index} with enough padding to make compaction measurable`);",
                    "  }",
                    '});',
                    ''
                ].join('\n'),
                'utf8'
            );

            const result = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'node-test',
                command: 'node --test tests/intermediate-pass.test.js',
                timeoutMs: 60_000
            });

            assert.equal(result.exitCode, 0);
            const output = result.outputLines.join('\n');
            assert.ok(output.includes('INTERMEDIATE_COMMAND_PASSED'));
            assert.ok(output.includes('CommandSource: node-test'));
            assert.ok(output.includes('OutputArtifact:'));
            assert.ok(output.includes('OutputTelemetry:'));
            assert.ok(!output.includes('VISIBLE_RAW_LINE_ONE'));
            assert.ok(!output.includes('secret-value'));

            const outputArtifactLine = result.outputLines.find((line) => line.startsWith('OutputArtifact: '));
            assert.ok(outputArtifactLine);
            const outputArtifactPath = outputArtifactLine.slice('OutputArtifact: '.length);
            const artifactOutput = fs.readFileSync(outputArtifactPath, 'utf8');
            assert.ok(artifactOutput.length > 0);
            assert.ok(!artifactOutput.includes('secret-value'));

            const events = readTaskTimelineEvents(repoRoot, taskId);
            const event = events.find((candidate) => candidate.event_type === 'INTERMEDIATE_COMMAND_RUN');
            assert.ok(event);
            assert.equal(event.outcome, 'PASSED');
            const details = event.details as Record<string, unknown>;
            assert.equal(details?.command_source, 'node-test');
            assert.match(String(details?.artifact_sha256 || ''), /^[a-f0-9]{64}$/u);
            assert.match(String(details?.output_artifact_sha256 || ''), /^[a-f0-9]{64}$/u);
            assert.ok(Number(details?.output_artifact_size_bytes) > 0);
            const telemetry = details?.output_telemetry as Record<string, unknown> | undefined;
            assert.ok(telemetry);
            assert.ok(Number(telemetry.raw_line_count) > 0);
            assert.ok(Number(telemetry.filtered_line_count) > 0);
            assert.equal(telemetry.filter_mode, 'compact_summary');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows node-foundation focused test wrapper as a targeted intermediate command', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);

            const result = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'targeted-test',
                command: 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                timeoutMs: 60_000
            });

            assert.equal(result.exitCode, 0);
            const output = result.outputLines.join('\n');
            assert.ok(output.includes('INTERMEDIATE_COMMAND_PASSED'));
            assert.ok(output.includes('CommandSource: targeted-test'));

            const events = readTaskTimelineEvents(repoRoot, taskId);
            const event = events.find((candidate) => candidate.event_type === 'INTERMEDIATE_COMMAND_RUN');
            assert.ok(event);
            assert.equal((event.details as Record<string, unknown>)?.command_source, 'targeted-test');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows node-foundation focused test wrapper through the reviewer-facing CLI entrypoint', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);

            const cliPath = path.join(process.cwd(), 'bin', 'garda.js');
            const result = childProcess.spawnSync(
                process.execPath,
                [
                    cliPath,
                    'gate',
                    'run-intermediate-command',
                    '--task-id',
                    taskId,
                    '--command-source',
                    'targeted-test',
                    '--command',
                    'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts',
                    '--timeout-ms',
                    '60000',
                    '--repo-root',
                    repoRoot
                ],
                {
                    cwd: repoRoot,
                    encoding: 'utf8',
                    timeout: 60_000
                }
            );

            assert.equal(result.status, 0, result.stderr || result.stdout);
            const output = `${result.stdout}\n${result.stderr}`;
            assert.ok(output.includes('INTERMEDIATE_COMMAND_PASSED'));
            assert.ok(output.includes('CommandSource: targeted-test'));

            const events = readTaskTimelineEvents(repoRoot, taskId);
            const event = events.find((candidate) => candidate.event_type === 'INTERMEDIATE_COMMAND_RUN');
            assert.ok(event);
            assert.equal((event.details as Record<string, unknown>)?.command_source, 'targeted-test');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects arbitrary intermediate commands without recording token telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);

            const result = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'targeted-test',
                command: 'git status'
            });

            const output = result.outputLines.join('\n');
            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.ok(output.includes('INTERMEDIATE_COMMAND_REJECTED'));
            assert.ok(output.includes('CommandSource: targeted-test'));
            assert.ok(output.includes('not eligible'));
            const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
            const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
            assert.equal(events.some((event) => event.event_type === 'INTERMEDIATE_COMMAND_RUN'), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects path-qualified intermediate command shims', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);

            const npmShimResult = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'targeted-test',
                command: './npm test -- --runInBand'
            });
            const absoluteNodeResult = await runIntermediateCommandCommand({
                repoRoot,
                taskId,
                commandSource: 'node-test',
                command: `${path.join(repoRoot, 'node.exe')} --test intermediate-pass.test.js`
            });

            assert.equal(npmShimResult.exitCode, EXIT_GATE_FAILURE);
            assert.equal(absoluteNodeResult.exitCode, EXIT_GATE_FAILURE);
            assert.ok(npmShimResult.outputLines.join('\n').includes('INTERMEDIATE_COMMAND_REJECTED'));
            assert.ok(absoluteNodeResult.outputLines.join('\n').includes('INTERMEDIATE_COMMAND_REJECTED'));
            const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
            const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
            assert.equal(events.some((event) => event.event_type === 'INTERMEDIATE_COMMAND_RUN'), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects unsafe focused test wrapper targets without recording telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            seedNodeFoundationFocusedWrapperFixture(repoRoot);

            const rejectedCommands = [
                'node scripts/node-foundation/build-scripts.cjs test.js src/cli/not-a-focused-test.ts',
                'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/../secret.test.ts',
                'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates',
                'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.ts',
                'node scripts/node-foundation/build-scripts.cjs test.js --runInBand tests/node/gates/focused-command.test.ts',
                'node --test tests/node/gates/focused-command.test.ts',
                'npm test -- --help',
                'npm test -- tests/node/gates/focused-command.test.ts --runInBand',
                'npm test -- src/cli/not-a-focused-test.ts'
            ];

            for (const command of rejectedCommands) {
                const result = await runIntermediateCommandCommand({
                    repoRoot,
                    taskId,
                    commandSource: 'targeted-test',
                    command,
                    timeoutMs: 60_000
                });

                assert.equal(result.exitCode, EXIT_GATE_FAILURE, command);
                const output = result.outputLines.join('\n');
                assert.ok(output.includes('INTERMEDIATE_COMMAND_REJECTED'), command);
                assert.ok(output.includes('CommandSource: targeted-test'), command);
                assert.ok(output.includes('not eligible'), command);
            }

            const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
            const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
            assert.equal(events.some((event) => event.event_type === 'INTERMEDIATE_COMMAND_RUN'), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects unsafe node-test arguments without recording telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-INTERMEDIATE';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);

            for (const command of [
                'node --test --help',
                'node --test src/cli/not-a-focused-test.ts',
                'node --test tests/node/gates/../secret.test.ts',
                'node --test tests/node/gates/focused-command.test.ts --test-reporter spec',
                'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gates/focused-command.test.ts'
            ]) {
                const result = await runIntermediateCommandCommand({
                    repoRoot,
                    taskId,
                    commandSource: 'node-test',
                    command,
                    timeoutMs: 60_000
                });

                assert.equal(result.exitCode, EXIT_GATE_FAILURE, command);
                assert.ok(result.outputLines.join('\n').includes('INTERMEDIATE_COMMAND_REJECTED'), command);
            }

            const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', taskId + '.jsonl');
            const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
            assert.equal(events.some((event) => event.event_type === 'INTERMEDIATE_COMMAND_RUN'), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
