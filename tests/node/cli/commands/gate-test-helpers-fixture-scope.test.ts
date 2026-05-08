/**
 * Regression tests: compile-gate fixture scope fingerprint shape.
 *
 * Asserts that `writeCompilePassEvidence` (shared helper) writes
 * `scope_sha256` and `scope_content_sha256` values that match the
 * direct output of `getWorkspaceSnapshot()`.
 *
 * If the runtime scope fingerprint shape changes, these tests fail at
 * the helper level rather than at unrelated full-suite test time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getWorkspaceSnapshot } from '../../../../src/gates/compile-gate';
import {
    createTempRepo,
    getReviewsRoot,
    seedRuleFiles
} from './gate-test-repo-bootstrap';
import {
    writePreflight,
    writeCompilePassEvidence,
    seedTaskQueue,
    seedInitAnswers,
    prepareReviewDiffFixture
} from './gate-test-seed-helpers';

describe('gate-test-helpers fixture scope fingerprints', () => {
    it('writeCompilePassEvidence scope_sha256 matches getWorkspaceSnapshot', () => {
        const repoRoot = createTempRepo();
        try {
            seedRuleFiles(repoRoot);
            seedTaskQueue(repoRoot, 'T-fixture-scope');
            seedInitAnswers(repoRoot, 'Codex');
            const preflightPath = writePreflight(repoRoot, 'T-fixture-scope', {
                changed_files: ['src/app.ts'],
                detection_source: 'explicit_changed_files',
                include_untracked: false
            });
            prepareReviewDiffFixture(repoRoot, preflightPath);
            writeCompilePassEvidence(repoRoot, 'T-fixture-scope', preflightPath);

            const artifactPath = path.join(
                getReviewsRoot(repoRoot),
                'T-fixture-scope-compile-gate.json'
            );
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;

            const snapshot = getWorkspaceSnapshot(
                repoRoot,
                'explicit_changed_files',
                false,
                ['src/app.ts']
            );

            assert.strictEqual(
                artifact.scope_sha256,
                snapshot.scope_sha256,
                'scope_sha256 in fixture must match getWorkspaceSnapshot()'
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('writeCompilePassEvidence scope_content_sha256 matches getWorkspaceSnapshot', () => {
        const repoRoot = createTempRepo();
        try {
            seedRuleFiles(repoRoot);
            seedTaskQueue(repoRoot, 'T-fixture-scope-content');
            seedInitAnswers(repoRoot, 'Codex');
            const preflightPath = writePreflight(repoRoot, 'T-fixture-scope-content', {
                changed_files: ['src/app.ts'],
                detection_source: 'explicit_changed_files',
                include_untracked: false
            });
            prepareReviewDiffFixture(repoRoot, preflightPath);
            writeCompilePassEvidence(repoRoot, 'T-fixture-scope-content', preflightPath);

            const artifactPath = path.join(
                getReviewsRoot(repoRoot),
                'T-fixture-scope-content-compile-gate.json'
            );
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;

            const snapshot = getWorkspaceSnapshot(
                repoRoot,
                'explicit_changed_files',
                false,
                ['src/app.ts']
            );

            assert.ok(
                Object.prototype.hasOwnProperty.call(artifact, 'scope_content_sha256'),
                'fixture artifact must contain scope_content_sha256 field'
            );
            assert.strictEqual(
                artifact.scope_content_sha256,
                snapshot.scope_content_sha256,
                'scope_content_sha256 in fixture must match getWorkspaceSnapshot()'
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('writeCompilePassEvidence artifact contains all required scope fields', () => {
        const repoRoot = createTempRepo();
        try {
            seedRuleFiles(repoRoot);
            seedTaskQueue(repoRoot, 'T-fixture-scope-fields');
            seedInitAnswers(repoRoot, 'Codex');
            const preflightPath = writePreflight(repoRoot, 'T-fixture-scope-fields', {
                changed_files: ['src/app.ts'],
                detection_source: 'explicit_changed_files',
                include_untracked: false
            });
            prepareReviewDiffFixture(repoRoot, preflightPath);
            writeCompilePassEvidence(repoRoot, 'T-fixture-scope-fields', preflightPath);

            const artifactPath = path.join(
                getReviewsRoot(repoRoot),
                'T-fixture-scope-fields-compile-gate.json'
            );
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;

            const requiredScopeFields = [
                'scope_detection_source',
                'scope_include_untracked',
                'scope_changed_files',
                'scope_changed_files_count',
                'scope_changed_lines_total',
                'scope_changed_files_sha256',
                'scope_content_sha256',
                'scope_sha256'
            ];
            for (const field of requiredScopeFields) {
                assert.ok(
                    Object.prototype.hasOwnProperty.call(artifact, field),
                    `fixture artifact must contain field: ${field}`
                );
            }
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
