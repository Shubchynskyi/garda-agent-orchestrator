import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildStrictDecompositionDecisionArtifact,
    getStrictDecompositionDecisionEvidence,
    resolveStrictDecompositionDecisionArtifactPath
} from '../../../../src/gates/task-mode/strict-decomposition-decision';
import { writeJsonArtifact } from '../../../../src/cli/commands/gates/gates-artifacts';

describe('gates/strict-decomposition-decision', () => {
    it('builds split-required evidence with strict parent-derived children', () => {
        const artifact = buildStrictDecompositionDecisionArtifact({
            taskId: 'T-100',
            decision: 'split_required',
            taskSummary: 'Implement a risky strict workflow change with several review lanes.',
            reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
            scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
            expectedReviewTypes: ['code', 'security'],
            atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
            proposedChildTaskIds: ['T-100-1', 'T-100-2']
        });

        assert.equal(artifact.decision, 'split-required');
        assert.equal(artifact.task_profile, 'strict');
        assert.deepEqual(artifact.expected_review_types, ['code', 'security']);
        assert.deepEqual(artifact.proposed_children, [
            { task_id: 'T-100-1', profile: 'strict' },
            { task_id: 'T-100-2', profile: 'strict' }
        ]);
    });

    it('rejects split children that are not parent-derived', () => {
        assert.throws(
            () => buildStrictDecompositionDecisionArtifact({
                taskId: 'T-100',
                decision: 'split-required',
                taskSummary: 'Implement a risky strict workflow change with several review lanes.',
                reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
                scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
                expectedReviewTypes: ['code'],
                atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
                proposedChildTaskIds: ['T-101']
            }),
            /parent-derived/
        );
    });

    it('detects current and stale decision evidence by task summary binding', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-evidence-'));
        const taskSummary = 'Implement a risky strict workflow change with several review lanes.';
        const artifact = buildStrictDecompositionDecisionArtifact({
            taskId: 'T-100',
            decision: 'single-cycle',
            taskSummary,
            reason: 'The scope is localized enough to stay in one strict cycle.',
            scopeRisk: 'The change affects one command surface and a focused validator.',
            expectedReviewTypes: ['code'],
            atomicityConstraints: ['Keep command and validator together.']
        });
        const artifactPath = resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100');
        writeJsonArtifact(artifactPath, artifact);

        const current = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', taskSummary);
        assert.equal(current.evidence_status, 'PASS');
        assert.equal(current.decision, 'single-cycle');

        const stale = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', '', 'Different task summary text.');
        assert.equal(stale.evidence_status, 'EVIDENCE_TASK_SUMMARY_MISMATCH');
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reports missing and invalid JSON decision evidence', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-invalid-evidence-'));
        const missing = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100');
        assert.equal(missing.evidence_status, 'EVIDENCE_FILE_MISSING');

        const artifactPath = resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100');
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, '{not valid json', 'utf8');

        const invalid = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100');
        assert.equal(invalid.evidence_status, 'EVIDENCE_INVALID_JSON');
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects explicit evidence artifact paths outside the repo root', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-contained-'));
        const outsidePath = path.join(path.dirname(repoRoot), `outside-${path.basename(repoRoot)}.json`);

        assert.throws(
            () => resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100', outsidePath),
            /inside repo root/
        );
        assert.throws(
            () => getStrictDecompositionDecisionEvidence(repoRoot, 'T-100', outsidePath),
            /inside repo root/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects proposed children that do not preserve strict profile metadata', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'strict-decomposition-child-profile-'));
        const artifact = buildStrictDecompositionDecisionArtifact({
            taskId: 'T-100',
            decision: 'split-required',
            taskSummary: 'Implement a risky strict workflow change with several review lanes.',
            reason: 'The scope spans multiple lifecycle contracts and should be split before implementation.',
            scopeRisk: 'The change touches review routing, task queue metadata, and lifecycle evidence.',
            expectedReviewTypes: ['code'],
            atomicityConstraints: ['Keep artifact schema and recorder validation together.'],
            proposedChildTaskIds: ['T-100-1']
        });
        const artifactPath = resolveStrictDecompositionDecisionArtifactPath(repoRoot, 'T-100');
        writeJsonArtifact(artifactPath, {
            ...artifact,
            proposed_children: [{ task_id: 'T-100-1', profile: 'balanced' }]
        });

        const evidence = getStrictDecompositionDecisionEvidence(repoRoot, 'T-100');
        assert.match(evidence.evidence_status, /Proposed child profile must be strict/);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
