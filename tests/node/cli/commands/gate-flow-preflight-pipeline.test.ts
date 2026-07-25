import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    GATE_FLOW_PREFLIGHT_PIPELINE_MIGRATION_CHECKLIST,
    GATE_FLOW_PREFLIGHT_PIPELINE_STAGES,
    runGateFlowPreflightPipeline,
    type GateFlowPreflightPipeline
} from '../../../../src/cli/commands/gate-flows/support/gate-flow-preflight-pipeline';
import { runCompileGateCommand } from '../../../../src/cli/commands/gates';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import {
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    loadPostPreflightRulePack,
    loadTaskEntryRulePack,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeBudgetOutputFilters,
    writePreflight
} from './gate-test-helpers';

interface TestInput {
    rawTaskId: string;
}

interface TestParsed {
    taskId: string;
}

interface TestTaskModeEvidence {
    status: 'PASS';
}

interface TestPreflight {
    mode: 'FULL_PATH';
}

interface TestTimelineReadiness {
    ready: boolean;
}

type TestPipeline = GateFlowPreflightPipeline<
    TestInput,
    TestParsed,
    TestTaskModeEvidence,
    TestPreflight,
    TestTimelineReadiness,
    string
>;

function createTestPipeline(events: string[]): TestPipeline {
    return {
        parse(input) {
            events.push('parse');
            return { taskId: input.rawTaskId.trim() };
        },
        loadTaskModeEvidence(context) {
            events.push('task-mode');
            assert.equal(context.parsed.taskId, 'T-932-1');
            return { status: 'PASS' };
        },
        loadPreflight(context) {
            events.push('preflight');
            assert.equal(context.taskModeEvidence.status, 'PASS');
            return { mode: 'FULL_PATH' };
        },
        evaluateTimelineReadiness(context) {
            events.push('timeline');
            assert.equal(context.preflight.mode, 'FULL_PATH');
            return { ready: true };
        },
        emit(context) {
            events.push('emit');
            assert.equal(context.timelineReadiness.ready, true);
            return `${context.parsed.taskId}:${context.preflight.mode}`;
        }
    };
}

function normalizeCompileOutputContract(outputLines: string[]): string[] {
    return outputLines.map((line) => line
        .replace(/duration_ms=\d+/u, 'duration_ms=<duration>')
        .replace(/sha256=[a-f0-9]{64}/u, 'sha256=<sha256>'));
}

describe('gate-flow preflight pipeline', () => {
    it('publishes the canonical stage order', () => {
        assert.deepEqual(GATE_FLOW_PREFLIGHT_PIPELINE_STAGES, [
            'parse',
            'task-mode-evidence',
            'preflight',
            'timeline-readiness',
            'emit'
        ]);
    });

    it('tracks the compile pilot and remaining flow migrations', () => {
        assert.deepEqual(GATE_FLOW_PREFLIGHT_PIPELINE_MIGRATION_CHECKLIST, {
            compile: 'pilot-migrated',
            review: 'pending',
            'full-suite': 'pending',
            recovery: 'pending-after-recovery-decomposition'
        });
    });

    it('runs the canonical parse to emit sequence', async () => {
        const events: string[] = [];

        const output = await runGateFlowPreflightPipeline(
            { rawTaskId: ' T-932-1 ' },
            createTestPipeline(events)
        );

        assert.equal(output, 'T-932-1:FULL_PATH');
        assert.deepEqual(events, ['parse', 'task-mode', 'preflight', 'timeline', 'emit']);
    });

    it('awaits asynchronous core callbacks before advancing', async () => {
        const events: string[] = [];
        const pipeline = createTestPipeline(events);
        pipeline.loadTaskModeEvidence = async (context) => {
            events.push('task-mode:start');
            await Promise.resolve();
            events.push('task-mode:resolved');
            assert.equal(context.parsed.taskId, 'T-932-1');
            return { status: 'PASS' };
        };

        const output = await runGateFlowPreflightPipeline(
            { rawTaskId: 'T-932-1' },
            pipeline
        );

        assert.equal(output, 'T-932-1:FULL_PATH');
        assert.deepEqual(events, [
            'parse',
            'task-mode:start',
            'task-mode:resolved',
            'preflight',
            'timeline',
            'emit'
        ]);
    });

    it('runs extension hooks in registration order with accumulated context', async () => {
        const events: string[] = [];
        const pipeline = createTestPipeline(events);
        const statefulExtension = {
            events,
            afterParse(context: { parsed: TestParsed }) {
                this.events.push(`extension-a:parse:${context.parsed.taskId}`);
            },
            afterTaskModeEvidence(context: { taskModeEvidence: TestTaskModeEvidence }) {
                this.events.push(`extension-a:task-mode:${context.taskModeEvidence.status}`);
            },
            afterPreflight(context: { preflight: TestPreflight }) {
                this.events.push(`extension-a:preflight:${context.preflight.mode}`);
            },
            afterTimelineReadiness(context: { timelineReadiness: TestTimelineReadiness }) {
                this.events.push(`extension-a:timeline:${context.timelineReadiness.ready}`);
            },
            beforeEmit(context: { parsed: TestParsed }) {
                this.events.push(`extension-a:emit:${context.parsed.taskId}`);
            }
        };
        pipeline.extensions = [
            statefulExtension,
            {
                async afterParse(context) {
                    await Promise.resolve();
                    events.push(`extension-b:parse:${context.parsed.taskId}`);
                }
            }
        ];

        await runGateFlowPreflightPipeline({ rawTaskId: 'T-932-1' }, pipeline);

        assert.deepEqual(events, [
            'parse',
            'extension-a:parse:T-932-1',
            'extension-b:parse:T-932-1',
            'task-mode',
            'extension-a:task-mode:PASS',
            'preflight',
            'extension-a:preflight:FULL_PATH',
            'timeline',
            'extension-a:timeline:true',
            'extension-a:emit:T-932-1',
            'emit'
        ]);
    });

    it('stops before downstream stages when a core step fails', async () => {
        const events: string[] = [];
        const pipeline = createTestPipeline(events);
        pipeline.extensions = [
            {
                afterPreflight() {
                    events.push('extension:preflight');
                },
                afterTimelineReadiness() {
                    events.push('extension:timeline');
                },
                beforeEmit() {
                    events.push('extension:emit');
                }
            }
        ];
        pipeline.loadPreflight = () => {
            events.push('preflight');
            throw new Error('preflight rejected');
        };

        await assert.rejects(
            runGateFlowPreflightPipeline({ rawTaskId: 'T-932-1' }, pipeline),
            /preflight rejected/
        );
        assert.deepEqual(events, ['parse', 'task-mode', 'preflight']);
    });

    it('stops the pipeline and remaining hooks when an extension rejects', async () => {
        const events: string[] = [];
        const pipeline = createTestPipeline(events);
        pipeline.extensions = [
            {
                async afterTaskModeEvidence() {
                    events.push('extension-a:task-mode:start');
                    await Promise.resolve();
                    events.push('extension-a:task-mode:rejected');
                    throw new Error('extension rejected');
                }
            },
            {
                afterTaskModeEvidence() {
                    events.push('extension-b:task-mode');
                },
                afterPreflight() {
                    events.push('extension-b:preflight');
                }
            }
        ];

        await assert.rejects(
            runGateFlowPreflightPipeline({ rawTaskId: 'T-932-1' }, pipeline),
            /extension rejected/
        );
        assert.deepEqual(events, [
            'parse',
            'task-mode',
            'extension-a:task-mode:start',
            'extension-a:task-mode:rejected'
        ]);
    });
});

describe('compile gate shared preflight pipeline pilot', () => {
    it('preserves compile success output and task-bound evidence wiring', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-2-compile-pilot';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId);
            const commandsPath = path.join(repoRoot, 'commands.md');
            fs.writeFileSync(commandsPath, [
                '### Compile Gate (Mandatory)',
                '```bash',
                'node -e "console.log(\'build ok\')"',
                '```'
            ].join('\n'), 'utf8');

            assert.equal(runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Exercise the compile shared preflight pipeline pilot'
            }).exitCode, 0);
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

            const result = await runCompileGateCommand({
                repoRoot,
                taskId,
                preflightPath,
                commandsPath,
                outputFiltersPath,
                emitMetrics: false
            });
            const evidence = JSON.parse(fs.readFileSync(
                path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`),
                'utf8'
            )) as {
                preflight_path: string;
                task_mode: { task_id: string };
                rule_pack: { stage: string };
                post_preflight_sequence: { timeline_path: string };
            };

            assert.equal(result.exitCode, 0);
            assert.deepEqual(normalizeCompileOutputContract(result.outputLines), [
                'COMPILE_GATE_PASSED',
                'CompileSummary: PASSED | duration_ms=<duration> | exit_code=0 | errors=0 | warnings=0',
                'CompileOutputRetention: retained=false reason=SUCCESS_LOG_OMITTED '
                    + 'sha256=<sha256> lines=7 chars=166'
            ]);
            assert.equal(evidence.preflight_path, path.resolve(preflightPath).replace(/\\/g, '/'));
            assert.equal(evidence.task_mode.task_id, taskId);
            assert.equal(evidence.rule_pack.stage, 'POST_PREFLIGHT');
            assert.equal(
                evidence.post_preflight_sequence.timeline_path,
                path.join(
                    getOrchestratorRoot(repoRoot),
                    'runtime',
                    'task-events',
                    `${taskId}.jsonl`
                ).replace(/\\/g, '/')
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves missing shell-smoke failure and recovery output', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-932-2-compile-pilot-missing-shell-smoke';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
            const preflightPath = writePreflight(repoRoot, taskId);
            const commandsPath = path.join(repoRoot, 'commands.md');
            fs.writeFileSync(commandsPath, [
                '### Compile Gate (Mandatory)',
                '```bash',
                'node -e "console.log(\'build must not run\')"',
                '```'
            ].join('\n'), 'utf8');

            assert.equal(runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Reject compile pilot without shell-smoke evidence'
            }).exitCode, 0);
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

            const result = await runCompileGateCommand({
                repoRoot,
                taskId,
                preflightPath,
                commandsPath,
                outputFiltersPath,
                emitMetrics: false
            });
            const timelinePath = path.join(
                getOrchestratorRoot(repoRoot),
                'runtime',
                'task-events',
                `${taskId}.jsonl`
            ).replace(/\\/g, '/');
            const compileOutputPath = path.join(
                getReviewsRoot(repoRoot),
                `${taskId}-compile-output.log`
            ).replace(/\\/g, '/');
            const failureReason = `Task timeline '${timelinePath}' is missing `
                + 'SHELL_SMOKE_PREFLIGHT_RECORDED. Run shell-smoke-preflight before compile gate. '
                + `NextStep: run node garda-agent-orchestrator/bin/garda.js next-step "${taskId}" `
                + '--repo-root "." and follow its single recommended command before retrying compile-gate.';

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.deepEqual(normalizeCompileOutputContract(result.outputLines), [
                'COMPILE_GATE_FAILED',
                'CompileSummary: FAILED | duration_ms=<duration> | exit_code=3 | errors=0 | warnings=0',
                `CompileOutputPath: ${compileOutputPath}`,
                'CompileOutputRetention: retained=true reason=FULL_OUTPUT_RETAINED '
                    + 'sha256=null lines=0 chars=0',
                `Reason: ${failureReason}`
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
