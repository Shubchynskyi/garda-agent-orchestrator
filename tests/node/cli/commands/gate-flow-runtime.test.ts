import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    evaluateGateFlowTimelineReadiness,
    resolveGateFlowTimelinePath
} from '../../../../src/cli/commands/gate-flows/support/gate-flow-runtime';
import { createManagedTestTempDirectory } from './gate-test-temp-manager';

describe('cli gate-flow runtime helpers', () => {
    it('reports missing task timeline with the canonical path', () => {
        const repoRoot = createManagedTestTempDirectory('gate-flow-runtime-');
        const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const taskId = 'T-runtime-missing';
        const result = evaluateGateFlowTimelineReadiness({
            orchestratorRoot,
            repoRoot,
            taskId,
            requirements: [
                { eventType: 'RULE_PACK_LOADED', recoveryInstruction: 'Run load-rule-pack before compile gate.' }
            ]
        });

        assert.equal(result.timelinePath, resolveGateFlowTimelinePath(repoRoot, taskId));
        assert.deepEqual(result.violations, [
            `Task timeline not found: ${result.timelinePath.replace(/\\/g, '/')}`
        ]);
    });

    it('preserves gate-specific recovery text for missing timeline events', () => {
        const repoRoot = createManagedTestTempDirectory('gate-flow-runtime-');
        const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const taskId = 'T-runtime-events';
        const timelinePath = resolveGateFlowTimelinePath(repoRoot, taskId);
        fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
        fs.writeFileSync(timelinePath, `${JSON.stringify({
            event_type: 'RULE_PACK_LOADED',
            timestamp_utc: '2026-06-14T00:00:00.000Z'
        })}\n`, 'utf8');

        const result = evaluateGateFlowTimelineReadiness({
            orchestratorRoot,
            repoRoot,
            taskId,
            requirements: [
                { eventType: 'RULE_PACK_LOADED', recoveryInstruction: 'Run load-rule-pack before review gate.' },
                { eventType: 'HANDSHAKE_DIAGNOSTICS_RECORDED', recoveryInstruction: 'Run handshake-diagnostics before review gate.' }
            ]
        });

        assert.deepEqual(result.violations, [
            `Task timeline '${timelinePath.replace(/\\/g, '/')}' is missing HANDSHAKE_DIAGNOSTICS_RECORDED. Run handshake-diagnostics before review gate.`
        ]);
    });

    it('finds required lifecycle events outside the bounded optional-skill timeline tail', () => {
        const repoRoot = createManagedTestTempDirectory('gate-flow-runtime-');
        const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const taskId = 'T-runtime-large';
        const timelinePath = resolveGateFlowTimelinePath(repoRoot, taskId);
        fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
        const firstEvent = JSON.stringify({
            task_id: taskId,
            event_type: 'TASK_MODE_ENTERED',
            timestamp_utc: '2026-06-14T00:00:00.000Z'
        });
        const paddingEvent = JSON.stringify({
            task_id: taskId,
            event_type: 'NOISE',
            details: { payload: 'x'.repeat(2048) }
        });
        fs.writeFileSync(
            timelinePath,
            `${firstEvent}\n${Array.from({ length: 600 }, () => paddingEvent).join('\n')}\n`,
            'utf8'
        );

        const result = evaluateGateFlowTimelineReadiness({
            orchestratorRoot,
            repoRoot,
            taskId,
            requirements: [
                { eventType: 'TASK_MODE_ENTERED', recoveryInstruction: 'Run enter-task-mode before recovery.' }
            ]
        });

        assert.equal(result.timelineEvidence.boundedRead?.truncated, true);
        assert.equal(result.timelineEvidence.eventTypes.has('TASK_MODE_ENTERED'), true);
        assert.deepEqual(result.violations, []);
    });
});
