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
import * as path from 'node:path';

import { getWorkspaceSnapshot } from '../../../../src/gates/compile-gate';
import {
    createGateFixture,
    prepareGateFixtureReviewDiff,
    writeGateFixtureCompilePass,
    writeGateFixturePreflight
} from '../../gate-fixtures';

describe('gate-test-helpers fixture scope fingerprints', () => {
    it('writeCompilePassEvidence scope_sha256 matches getWorkspaceSnapshot', () => {
        const fixture = createGateFixture({ taskId: 'T-fixture-scope' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/app.ts'],
                detection_source: 'explicit_changed_files',
                include_untracked: false
            });
            prepareGateFixtureReviewDiff(fixture, preflightPath);
            writeGateFixtureCompilePass(fixture, preflightPath);

            const artifactPath = path.join(
                fixture.reviewsRoot,
                'T-fixture-scope-compile-gate.json'
            );
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;

            const snapshot = getWorkspaceSnapshot(
                fixture.repoRoot,
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
            fixture.cleanup();
        }
    });

    it('writeCompilePassEvidence scope_content_sha256 matches getWorkspaceSnapshot', () => {
        const fixture = createGateFixture({ taskId: 'T-fixture-scope-content' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/app.ts'],
                detection_source: 'explicit_changed_files',
                include_untracked: false
            });
            prepareGateFixtureReviewDiff(fixture, preflightPath);
            writeGateFixtureCompilePass(fixture, preflightPath);

            const artifactPath = path.join(
                fixture.reviewsRoot,
                'T-fixture-scope-content-compile-gate.json'
            );
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;

            const snapshot = getWorkspaceSnapshot(
                fixture.repoRoot,
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
            fixture.cleanup();
        }
    });

    it('writeCompilePassEvidence artifact contains all required scope fields', () => {
        const fixture = createGateFixture({ taskId: 'T-fixture-scope-fields' });
        try {
            const preflightPath = writeGateFixturePreflight(fixture, {
                changed_files: ['src/app.ts'],
                detection_source: 'explicit_changed_files',
                include_untracked: false
            });
            prepareGateFixtureReviewDiff(fixture, preflightPath);
            writeGateFixtureCompilePass(fixture, preflightPath);

            const artifactPath = path.join(
                fixture.reviewsRoot,
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
            fixture.cleanup();
        }
    });
});
