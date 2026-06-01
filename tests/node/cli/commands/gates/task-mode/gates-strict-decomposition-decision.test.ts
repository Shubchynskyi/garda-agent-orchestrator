import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runRecordStrictDecompositionDecisionCommand } from '../../../../../../src/cli/commands/gates';

describe('cli/gates record-strict-decomposition-decision', () => {
    function baseOptions(repoRoot: string): Parameters<typeof runRecordStrictDecompositionDecisionCommand>[0] {
        return {
            repoRoot,
            taskId: 'T-200',
            decision: 'atomic',
            taskSummary: 'Keep a tiny strict fix atomic because the observable behavior is indivisible.',
            reason: 'The task updates one indivisible runtime contract and must not be split.',
            scopeRisk: 'Small scope with one expected code review lane and no child routing.',
            expectedReviewTypes: ['code'],
            atomicityConstraints: ['The runtime contract and its direct assertion must land together.']
        };
    }

    it('writes the decision artifact and task-event evidence', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-strict-decomposition-cli-'));
        const result = runRecordStrictDecompositionDecisionCommand(baseOptions(repoRoot));

        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'STRICT_DECOMPOSITION_DECISION_RECORDED');
        assert.ok(result.outputLines.some((line) => line.includes('Decision: atomic')));

        const artifactPath = path.join(repoRoot, 'runtime', 'reviews', 'T-200-strict-decomposition-decision.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(artifact.event_source, 'strict-decomposition-decision');
        assert.equal(artifact.decision, 'atomic');
        assert.equal(artifact.task_profile, 'strict');

        const eventsPath = path.join(repoRoot, 'runtime', 'task-events', 'T-200.jsonl');
        const events = fs.readFileSync(eventsPath, 'utf8');
        assert.match(events, /STRICT_DECOMPOSITION_DECISION_RECORDED/);
        assert.match(events, /strict-decomposition-decision/);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects explicit artifact and metrics paths outside the repo root', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-strict-decomposition-cli-contained-'));
        const outsideArtifactPath = path.join(path.dirname(repoRoot), `outside-artifact-${path.basename(repoRoot)}.json`);
        const outsideMetricsPath = path.join(path.dirname(repoRoot), `outside-metrics-${path.basename(repoRoot)}.jsonl`);

        assert.throws(
            () => runRecordStrictDecompositionDecisionCommand({
                ...baseOptions(repoRoot),
                artifactPath: outsideArtifactPath
            }),
            /inside repo root/
        );
        assert.throws(
            () => runRecordStrictDecompositionDecisionCommand({
                ...baseOptions(repoRoot),
                metricsPath: outsideMetricsPath
            }),
            /inside repo root/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
