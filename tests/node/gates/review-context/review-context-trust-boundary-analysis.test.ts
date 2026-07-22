import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    appendMandatoryTaskEvent
} from '../../../../src/gate-runtime/task-events';

import {
    buildDefaultWorkflowConfig
} from '../../../../src/core/workflow-config';
import {
    TRUST_BOUNDARY_ANALYSIS_RULE_ID
} from '../../../../src/core/trust-boundary-analysis';
import {
    buildQualityChecklistArtifact,
    resolveDefaultQualityChecklistArtifactPath
} from '../../../../src/gates/quality-checklist';
import {
    buildTrustBoundaryAnalysisMarkdown,
    readReviewContextTrustBoundaryAnalysis
} from '../../../../src/gates/review-context/review-context-trust-boundary-analysis';
import {
    fileSha256
} from '../../../../src/gates/shared/helpers';
import {
    createGateFixture,
    writeGateFixturePreflight
} from '../../gate-fixtures';

function buildAnswers(): Array<Record<string, unknown>> {
    const scenario = 'fails closed for missing, replaced, foreign, and stale matrix artifacts';
    const universalAnswers = buildDefaultWorkflowConfig().optional_quality_checks.rules
        .filter((rule) => !rule.included_changed_file_regexes?.length)
        .map((rule) => ({
            rule_id: rule.id,
            status: 'PASS',
            answer: `Checked ${rule.id}.`,
            evidence_files: ['src/gates/review/review-findings-schema.ts']
        }));
    return [...universalAnswers, {
        rule_id: TRUST_BOUNDARY_ANALYSIS_RULE_ID,
        status: 'PASS',
        answer: 'Mapped the reviewer output receipt boundary.',
        evidence_files: ['tests/node/gates/review-context/review-context-trust-boundary-analysis.test.ts'],
        trust_boundary_matrix: [{
            boundary_id: 'TB-001',
            boundary: 'Mutable reviewer output to authenticated receipt',
            authority_source: 'Gate-owned launch input and receipt bindings',
            mutable_inputs: ['provider reviewer output'],
            integrity_evidence: ['launch input sha256', 'review context sha256'],
            canonical_reconstruction: 'Rebuild the receipt from immutable launch input and normalized findings.',
            toctou_replay: 'Reject prior-cycle or pre-delegation output.',
            negative_paths: [{
                kind: 'foreign',
                scenario,
                expected_behavior: 'Reject without accepted review state.',
                evidence_files: [
                    `tests/node/gates/review-context/review-context-trust-boundary-analysis.test.ts#${scenario}`
                ]
            }]
        }]
    }];
}

function writeCurrentArtifact(fixture: ReturnType<typeof createGateFixture>, preflightPath: string): string {
    const evidencePath = path.join(
        fixture.repoRoot,
        'tests',
        'node',
        'gates',
        'review-context',
        'review-context-trust-boundary-analysis.test.ts'
    );
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(
        evidencePath,
        "test('fails closed for missing, replaced, foreign, and stale matrix artifacts', () => { assert.equal(true, true); });\n",
        'utf8'
    );
    const artifact = buildQualityChecklistArtifact({
        repoRoot: fixture.repoRoot,
        taskId: fixture.taskId,
        preflightPath,
        answers: buildAnswers()
    });
    const artifactPath = resolveDefaultQualityChecklistArtifactPath(fixture.repoRoot, fixture.taskId);
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    const artifactSha256 = fileSha256(artifactPath);
    appendMandatoryTaskEvent(
        fixture.orchestratorRoot,
        fixture.taskId,
        'QUALITY_CHECKLIST_RECORDED',
        artifact.outcome,
        `Quality checklist recorded: ${artifact.status}.`,
        {
            artifact_path: artifactPath.replace(/\\/gu, '/'),
            artifact_hash: artifactSha256,
            status: artifact.status,
            outcome: artifact.outcome,
            checklist_id: artifact.checklist_id,
            preflight_path: artifact.preflight_path,
            preflight_sha256: artifact.preflight_sha256
        }
    );
    return artifactPath;
}

describe('review-context trust-boundary handoff', () => {
    it('renders the authenticated current matrix into reviewer prompt content', () => {
        const fixture = createGateFixture({ taskId: 'T-review-trust-boundary' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/gates/review/review-findings-schema.ts'],
                triggers: { security: true }
            });
            writeCurrentArtifact(fixture, preflightPath);
            const analysis = readReviewContextTrustBoundaryAnalysis({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
                preflightSha256: fileSha256(preflightPath)
            });

            assert.equal(analysis.status, 'current');
            assert.equal(analysis.artifact_sha256, analysis.recorded_artifact_sha256);
            assert.match(String(analysis.binding_event_sha256), /^[a-f0-9]{64}$/u);
            assert.equal(analysis.matrix.length, 1);
            const promptSection = buildTrustBoundaryAnalysisMarkdown(analysis).join('\n');
            assert.match(promptSection, /Trust-Boundary Analysis/u);
            assert.match(promptSection, /Mutable reviewer output to authenticated receipt/u);
            assert.match(promptSection, /\[foreign\]/u);
            assert.match(promptSection, /verify every listed boundary and negative path/u);
        } finally {
            fixture.cleanup();
        }
    });

    it('fails closed for missing, replaced, foreign, and stale matrix artifacts', () => {
        const scenarios = ['missing', 'replaced', 'foreign', 'stale'] as const;
        for (const scenario of scenarios) {
            const fixture = createGateFixture({ taskId: `T-review-trust-${scenario}` });
            try {
                const preflightPath = writeGateFixturePreflight(fixture, {
                    changed_files: ['src/gates/review/review-findings-schema.ts'],
                    triggers: { security: true }
                });
                const artifactPath = resolveDefaultQualityChecklistArtifactPath(fixture.repoRoot, fixture.taskId);
                if (scenario !== 'missing') {
                    writeCurrentArtifact(fixture, preflightPath);
                    if (scenario === 'replaced') {
                        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                        const answer = artifact.answers.find((entry: Record<string, unknown>) => (
                            entry.rule_id === TRUST_BOUNDARY_ANALYSIS_RULE_ID
                        ));
                        answer.trust_boundary_matrix[0].boundary = 'Syntactically valid replacement matrix';
                        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
                    } else {
                        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                        if (scenario === 'foreign') artifact.task_id = 'T-foreign';
                        if (scenario === 'stale') artifact.preflight_sha256 = '0'.repeat(64);
                        fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
                    }
                }
                const analysis = readReviewContextTrustBoundaryAnalysis({
                    repoRoot: fixture.repoRoot,
                    taskId: fixture.taskId,
                    preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
                    preflightSha256: fileSha256(preflightPath)
                });
                assert.notEqual(analysis.status, 'current', scenario);
                assert.equal(analysis.matrix.length, 0, scenario);
                assert.ok(analysis.violations.length > 0, scenario);
                if (scenario === 'replaced') {
                    assert.match(analysis.violations.join(' '), /does not match its gate-recorded/u);
                }
            } finally {
                fixture.cleanup();
            }
        }
        assert.equal(scenarios.length, 4);
    });

    it('hashes and parses one immutable artifact byte snapshot', () => {
        const fixture = createGateFixture({ taskId: 'T-review-trust-snapshot' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/gates/review/review-findings-schema.ts'],
                triggers: { security: true }
            });
            const artifactPath = writeCurrentArtifact(fixture, preflightPath);
            const originalReadFileSync = fs.readFileSync;
            let artifactReadCount = 0;
            const readMock = mock.method(fs, 'readFileSync', (
                filePath: fs.PathOrFileDescriptor,
                options?: BufferEncoding | null
            ) => {
                const result = options
                    ? originalReadFileSync(filePath, options)
                    : originalReadFileSync(filePath);
                if (path.resolve(String(filePath)) === path.resolve(artifactPath)) {
                    artifactReadCount += 1;
                    if (artifactReadCount === 1) {
                        const replacement = JSON.parse(Buffer.isBuffer(result) ? result.toString('utf8') : result);
                        replacement.task_id = 'T-foreign-after-read';
                        fs.writeFileSync(artifactPath, `${JSON.stringify(replacement, null, 2)}\n`, 'utf8');
                    }
                }
                return result;
            });
            try {
                const analysis = readReviewContextTrustBoundaryAnalysis({
                    repoRoot: fixture.repoRoot,
                    taskId: fixture.taskId,
                    preflight: JSON.parse(originalReadFileSync(preflightPath, 'utf8')),
                    preflightSha256: fileSha256(preflightPath)
                });

                assert.equal(analysis.status, 'current');
                assert.equal(artifactReadCount, 1);
                assert.equal(readMock.mock.callCount() > 0, true);
            } finally {
                mock.restoreAll();
            }
        } finally {
            fixture.cleanup();
        }
    });

    it('rejects an external artifact junction before hashing its target', (t) => {
        const fixture = createGateFixture({ taskId: 'T-review-trust-external-junction' });
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-trust-outside-'));
        let linkedReviewsRoot: string | null = null;
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/gates/review/review-findings-schema.ts'],
                triggers: { security: true }
            });
            const artifactPath = writeCurrentArtifact(fixture, preflightPath);
            const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            const preflightSha256 = fileSha256(preflightPath);
            const reviewsRoot = path.dirname(artifactPath);
            const outsideReviewsRoot = path.join(outsideRoot, 'reviews');
            fs.cpSync(reviewsRoot, outsideReviewsRoot, { recursive: true });
            fs.rmSync(reviewsRoot, { recursive: true, force: true });
            try {
                fs.symlinkSync(
                    outsideReviewsRoot,
                    reviewsRoot,
                    process.platform === 'win32' ? 'junction' : 'dir'
                );
                linkedReviewsRoot = reviewsRoot;
            } catch (error: unknown) {
                t.skip(`directory junction creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const analysis = readReviewContextTrustBoundaryAnalysis({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflight,
                preflightSha256
            });

            assert.equal(analysis.status, 'invalid');
            assert.equal(analysis.artifact_sha256, null);
            assert.match(analysis.violations.join(' '), /escapes the repository through a symlink or junction/u);
        } finally {
            if (linkedReviewsRoot) {
                fs.rmSync(linkedReviewsRoot, { recursive: true, force: true });
            }
            fixture.cleanup();
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });

    it('skips unrelated low-risk changes', () => {
        const fixture = createGateFixture({ taskId: 'T-review-trust-skip' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/domain/catalog.ts'],
                triggers: {}
            });
            const analysis = readReviewContextTrustBoundaryAnalysis({
                repoRoot: fixture.repoRoot,
                taskId: fixture.taskId,
                preflight: JSON.parse(fs.readFileSync(preflightPath, 'utf8')),
                preflightSha256: fileSha256(preflightPath)
            });
            assert.equal(analysis.status, 'not_required');
            assert.deepEqual(buildTrustBoundaryAnalysisMarkdown(analysis), []);
        } finally {
            fixture.cleanup();
        }
    });
});
