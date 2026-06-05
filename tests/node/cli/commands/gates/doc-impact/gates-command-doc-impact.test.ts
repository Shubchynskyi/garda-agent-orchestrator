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

function writeInternalChangelogEvidence(repoRoot: string, taskId: string): void {
    const filePath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'changes', 'CHANGELOG.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `# Internal Changelog\n\n- ${taskId}: internal runtime behavior documented.\n`, 'utf8');
}

function writeProjectMemoryEvidence(repoRoot: string, taskId: string): void {
    const filePath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'compact.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `# Compact Memory\n\n- ${taskId}: internal runtime behavior documented.\n`, 'utf8');
}

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
        writeInternalChangelogEvidence(repoRoot, taskId);
        writeProjectMemoryEvidence(repoRoot, taskId);

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
            project_memory_updated: true,
            internal_changelog_path: 'garda-agent-orchestrator/live/docs/changes/CHANGELOG.md',
            internal_changelog_sha256: artifact.internal_closeout_evidence.internal_changelog_sha256,
            project_memory_files: artifact.internal_closeout_evidence.project_memory_files
        });
        assert.equal(artifact.internal_closeout_evidence.project_memory_files.length, 1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('accepts internal-only behavior changes documented by internal closeout evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-internal-behavior';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        writeInternalChangelogEvidence(repoRoot, taskId);
        writeProjectMemoryEvidence(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: true,
            changelogUpdated: false,
            internalChangelogUpdated: true,
            projectMemoryUpdated: true,
            rationale: 'Internal runtime behavior is documented in internal changelog and project memory.',
            emitMetrics: false
        });

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-doc-impact.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'DOC_IMPACT_GATE_PASSED');
        assert.equal(artifact.decision, 'NO_DOC_UPDATES');
        assert.equal(artifact.behavior_changed, true);
        assert.equal(artifact.changelog_updated, false);
        assert.equal(artifact.internal_changelog_updated, true);
        assert.equal(artifact.project_memory_updated, true);
        assert.deepEqual(artifact.docs_updated, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects internal-only behavior evidence flags without durable task evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-internal-bare-flags';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: true,
            changelogUpdated: false,
            internalChangelogUpdated: true,
            projectMemoryUpdated: true,
            rationale: 'Internal runtime behavior claims evidence without durable task files.',
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.ok(result.outputLines.some((line) => line.includes('InternalChangelogUpdated=true requires task-scoped durable evidence')));
        assert.ok(result.outputLines.some((line) => line.includes('ProjectMemoryUpdated=true requires task-scoped durable evidence')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects internal-only behavior evidence files that belong to another task', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-internal-stale-evidence';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        writeInternalChangelogEvidence(repoRoot, 'T-999');
        writeProjectMemoryEvidence(repoRoot, 'T-999');

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: true,
            changelogUpdated: false,
            internalChangelogUpdated: true,
            projectMemoryUpdated: true,
            rationale: 'Internal runtime behavior claims stale evidence from another task.',
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.ok(result.outputLines.some((line) => line.includes('InternalChangelogUpdated=true requires task-scoped durable evidence')));
        assert.ok(result.outputLines.some((line) => line.includes('ProjectMemoryUpdated=true requires task-scoped durable evidence')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects undocumented behavior changes without user-facing or internal evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-undocumented-behavior';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: true,
            changelogUpdated: false,
            rationale: 'Behavior changed but no durable documentation evidence is present.',
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.ok(result.outputLines.some((line) => line.includes('internal closeout evidence')));
        assert.ok(result.outputLines.some((line) => line.includes('NO_DOC_UPDATES is incompatible with BehaviorChanged=true')));

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
        assert.ok(result.outputLines.some((line) => line.includes('BehaviorChanged=true requires ChangelogUpdated=true or internal closeout evidence.')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects user-facing behavior docs without changelog even when internal evidence exists', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902-user-docs-internal-evidence';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        writeInternalChangelogEvidence(repoRoot, taskId);
        writeProjectMemoryEvidence(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'DOCS_UPDATED',
            behaviorChanged: true,
            changelogUpdated: false,
            internalChangelogUpdated: true,
            projectMemoryUpdated: true,
            docsUpdated: ['docs/cli-reference.md'],
            rationale: 'User-facing behavior changed and docs were updated.',
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.ok(result.outputLines.some((line) => line.includes('BehaviorChanged=true requires ChangelogUpdated=true or internal closeout evidence.')));

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
