import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    GATE_FLOW_PREFLIGHT_PIPELINE_STAGES,
    runGateFlowPreflightPipeline,
    type GateFlowPreflightPipeline
} from '../../../../src/cli/commands/gate-flows/support/gate-flow-preflight-pipeline';

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
