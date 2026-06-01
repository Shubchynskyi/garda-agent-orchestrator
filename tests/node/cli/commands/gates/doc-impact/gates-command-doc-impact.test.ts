import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    EXIT_GATE_FAILURE
} from '../../../../../../src/cli/exit-codes';
import {
    runDocImpactGateCommand
} from '../../../../../../src/cli/commands/gates';

import {
    createTempRepo,
    seedTaskQueue,
    seedInitAnswers,
    writePreflight,
    getReviewsRoot
} from '../../gate-test-helpers';

describe('cli/commands/gates doc-impact', () => {
    it('passes doc-impact gate and writes artifact', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Internal cleanup only, no public behavior change.',
            emitMetrics: false
        });

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-doc-impact.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'DOC_IMPACT_GATE_PASSED');
        assert.equal(artifact.status, 'PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('records internal doc-impact closeout evidence without user-facing docs_updated paths', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-internal-closeout';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            internalChangelogUpdated: true,
            projectMemoryUpdated: true,
            rationale: 'Only internal closeout evidence changed.',
            emitMetrics: false
        });

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-doc-impact.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(artifact.decision, 'NO_DOC_UPDATES');
        assert.deepEqual(artifact.docs_updated, []);
        assert.equal(artifact.changelog_updated, false);
        assert.equal(artifact.internal_changelog_updated, true);
        assert.equal(artifact.project_memory_updated, true);
        assert.deepEqual(artifact.internal_closeout_evidence, {
            internal_changelog_updated: true,
            project_memory_updated: true
        });

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps user-facing docs_updated valid with changelog evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-user-docs';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'DOCS_UPDATED',
            behaviorChanged: true,
            changelogUpdated: true,
            docsUpdated: ['docs/cli-reference.md'],
            rationale: 'User-facing documentation and changelog were updated.',
            emitMetrics: false
        });

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-doc-impact.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.deepEqual(artifact.docs_updated, ['docs/cli-reference.md']);
        assert.equal(artifact.changelog_updated, true);
        assert.equal(artifact.internal_changelog_updated, false);
        assert.equal(artifact.project_memory_updated, false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects behavior-changing doc impact without changelog evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-missing-changelog';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'DOCS_UPDATED',
            behaviorChanged: true,
            changelogUpdated: false,
            docsUpdated: ['docs/cli-reference.md'],
            rationale: 'User-facing behavior changed and docs were updated.',
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.ok(result.outputLines.some((line) => line.includes('BehaviorChanged=true requires ChangelogUpdated=true.')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects internal closeout paths in docs_updated', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-invalid-mixed-docs';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'DOCS_UPDATED',
            behaviorChanged: false,
            changelogUpdated: false,
            projectMemoryUpdated: true,
            docsUpdated: ['garda-agent-orchestrator/live/docs/project-memory/commands.md'],
            rationale: 'Project memory changed during closeout.',
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.ok(result.outputLines.some((line) => line.includes('docs_updated is reserved for user-facing documentation.')));
        assert.ok(result.outputLines.some((line) => line.includes('--project-memory-updated true')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects absolute internal closeout paths in docs_updated', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-invalid-absolute-docs';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const internalMemoryPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'commands.md');

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'DOCS_UPDATED',
            behaviorChanged: false,
            changelogUpdated: false,
            projectMemoryUpdated: true,
            docsUpdated: [internalMemoryPath],
            rationale: 'Project memory changed during closeout.',
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.ok(result.outputLines.some((line) => line.includes('docs_updated is reserved for user-facing documentation.')));
        assert.ok(result.outputLines.some((line) => line.includes('garda-agent-orchestrator/live/docs/project-memory/commands.md')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
