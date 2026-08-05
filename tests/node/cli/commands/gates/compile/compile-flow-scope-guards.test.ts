import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildCompileScopeDriftMessage,
    getNewManifestChangedFiles,
    getTaskOwnedManifestChangedFiles,
    resolveCompileWorkflowConfigChangedFiles
} from '../../../../../../src/cli/commands/gate-flows/compile/compile-flow-scope-guards';
import {
    buildCompileGeneratedProtectedArtifactEvidence,
    captureCompileGeneratedProtectedArtifactHashes,
    validateCompileGeneratedProtectedArtifactEvidence
} from '../../../../../../src/gates/protected-control-plane/compile-generated-protected-artifacts';
import {
    getProtectedManifestLifecycleGuard
} from '../../../../../../src/gates/protected-control-plane/protected-manifest-guard';
import { fileSha256, normalizePath } from '../../../../../../src/gates/shared/helpers';

describe('compile-flow scope guards', () => {
    it('returns no scope drift message when preflight and current scope fingerprints match', () => {
        const message = buildCompileScopeDriftMessage({
            preflightContext: {
                changed_files_sha256: 'files-sha',
                changed_lines_total: 4,
                detection_source: 'git_auto',
                scope_sha256: 'scope-sha'
            },
            workspaceSnapshot: {
                changed_files_sha256: 'files-sha',
                changed_lines_total: 4,
                detection_source: 'git_auto',
                scope_sha256: 'scope-sha'
            }
        });

        assert.equal(message, null);
    });

    it('builds explicit-scope recovery text for stale planned preflight fingerprints', () => {
        const message = buildCompileScopeDriftMessage({
            preflightContext: {
                changed_files_sha256: 'planned-files',
                changed_lines_total: 0,
                detection_source: 'explicit_changed_files',
                scope_sha256: 'planned-scope'
            },
            workspaceSnapshot: {
                changed_files_sha256: 'real-files',
                changed_lines_total: 12,
                detection_source: 'explicit_changed_files',
                scope_sha256: 'real-scope'
            }
        });

        assert.match(String(message), /Preflight scope drift detected\./);
        assert.match(String(message), /Refresh preflight for the real diff/);
        assert.match(String(message), /planned --changed-file inputs/);
        assert.match(String(message), /Preflight changed_files differ from current workspace snapshot/);
    });

    it('matches task-owned generated dist files back to changed source files', () => {
        assert.deepEqual(
            getTaskOwnedManifestChangedFiles(
                ['src/cli/commands/gate-flows/compile-flow.ts'],
                [
                    'dist/src/cli/commands/gate-flows/compile-flow.js',
                    'dist/src/cli/commands/gate-flows/unrelated.js',
                    'src/cli/commands/gate-flows/compile-flow.ts'
                ]
            ),
            [
                'dist/src/cli/commands/gate-flows/compile-flow.js',
                'src/cli/commands/gate-flows/compile-flow.ts'
            ]
        );
    });

    it('reports only newly introduced protected manifest drift files', () => {
        assert.deepEqual(
            getNewManifestChangedFiles(
                ['dist/src/existing.js', 'src/existing.ts'],
                ['src/new.ts', 'dist/src/existing.js', 'src/new.ts']
            ),
            ['src/new.ts']
        );
    });

    it('binds compile-generated publish manifest allowance to the exact post-compile hash', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-generated-protected-'));
        const artifactPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
        const preflightPath = path.join(repoRoot, 'preflight.json');
        try {
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
                name: 'garda-agent-orchestrator'
            }), 'utf8');
            fs.writeFileSync(preflightPath, '{"task_id":"T-1"}\n', 'utf8');
            fs.writeFileSync(artifactPath, '{"version":1}\n', 'utf8');
            const before = captureCompileGeneratedProtectedArtifactHashes(repoRoot);
            fs.writeFileSync(artifactPath, '{"version":2}\n', 'utf8');
            const after = captureCompileGeneratedProtectedArtifactHashes(repoRoot);
            const transition = buildCompileGeneratedProtectedArtifactEvidence(before, after);
            assert.ok(transition);
            const preflightSha256 = fileSha256(preflightPath);
            const generatedArtifactSha256 = fileSha256(artifactPath);
            const staleSnapshotSha256 = before['dist/publish-runtime-manifest.json'];
            assert.ok(preflightSha256);
            assert.ok(generatedArtifactSha256);
            assert.ok(staleSnapshotSha256);

            const compileEvidence = {
                task_id: 'T-1',
                status: 'PASSED',
                outcome: 'PASS',
                preflight_path: normalizePath(preflightPath),
                preflight_hash_sha256: preflightSha256,
                compile_generated_protected_artifacts: transition
            };
            const accepted = validateCompileGeneratedProtectedArtifactEvidence({
                repoRoot,
                compileEvidence,
                taskId: 'T-1',
                preflightPath,
                preflightSha256,
                currentProtectedSnapshot: {
                    'dist/publish-runtime-manifest.json': staleSnapshotSha256
                }
            });
            assert.deepEqual(accepted.violations, []);
            assert.deepEqual(accepted.allowed_changed_files, ['dist/publish-runtime-manifest.json']);

            fs.writeFileSync(artifactPath, '{"version":3}\n', 'utf8');
            const tamperedArtifactSha256 = fileSha256(artifactPath);
            assert.ok(tamperedArtifactSha256);
            const rejected = validateCompileGeneratedProtectedArtifactEvidence({
                repoRoot,
                compileEvidence,
                taskId: 'T-1',
                preflightPath,
                preflightSha256,
                currentProtectedSnapshot: {
                    'dist/publish-runtime-manifest.json': generatedArtifactSha256
                }
            });
            assert.deepEqual(rejected.allowed_changed_files, []);
            assert.match(rejected.violations.join('\n'), /changed after compile-gate evidence was recorded/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks external protected change despite compile-owned publish manifest evidence', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-generated-protected-drift-'));
        try {
            fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
                name: 'garda-agent-orchestrator'
            }), 'utf8');
            const externalProtectedPath = 'src/gates/external-change.ts';
            const result = getProtectedManifestLifecycleGuard({
                repoRoot,
                orchestratorWork: false,
                phaseLabel: 'compile output validation',
                preflight: {
                    triggers: {
                        protected_control_plane_manifest_status: 'MATCH',
                        protected_control_plane_manifest_changed_files: []
                    }
                },
                manifestEvidence: {
                    status: 'DRIFT',
                    manifest_path: normalizePath(path.join(repoRoot, 'protected-manifest.json')),
                    changed_files: [
                        'dist/publish-runtime-manifest.json',
                        externalProtectedPath
                    ],
                    manifest: {
                        schema_version: 1,
                        event_source: 'refresh-protected-control-plane-manifest',
                        timestamp_utc: '2026-07-31T00:00:00.000Z',
                        workspace_root: normalizePath(repoRoot),
                        orchestrator_root: normalizePath(repoRoot),
                        protected_roots: ['dist/', 'src/gates/'],
                        protected_snapshot: {},
                        is_source_checkout: true
                    }
                },
                lifecycleOwnedManifestChangedFiles: ['dist/publish-runtime-manifest.json']
            });
            assert.equal(result.status, 'BLOCK');
            assert.match(result.violations.join('\n'), new RegExp(externalProtectedPath.replaceAll('/', '\\/'), 'u'));
            assert.doesNotMatch(result.violations.join('\n'), /unknown protected files/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('uses preflight workflow-config paths only when the task-mode baseline is missing', () => {
        assert.deepEqual(
            resolveCompileWorkflowConfigChangedFiles({
                baselineFileHashes: null,
                changedFiles: [],
                preflightChangedFiles: [
                    'garda-agent-orchestrator/live/config/workflow-config.json',
                    'src/feature.ts'
                ],
                workflowConfigControlPlanePaths: [
                    'garda-agent-orchestrator/live/config/workflow-config.json'
                ]
            }),
            ['garda-agent-orchestrator/live/config/workflow-config.json']
        );

        assert.deepEqual(
            resolveCompileWorkflowConfigChangedFiles({
                baselineFileHashes: {
                    'garda-agent-orchestrator/live/config/workflow-config.json': 'sha'
                },
                changedFiles: [],
                preflightChangedFiles: [
                    'garda-agent-orchestrator/live/config/workflow-config.json'
                ],
                workflowConfigControlPlanePaths: [
                    'garda-agent-orchestrator/live/config/workflow-config.json'
                ]
            }),
            []
        );
    });
});
