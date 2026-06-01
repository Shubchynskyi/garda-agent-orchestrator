import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCompileScopeDriftMessage,
    getNewManifestChangedFiles,
    getTaskOwnedManifestChangedFiles,
    resolveCompileWorkflowConfigChangedFiles
} from '../../../../../../src/cli/commands/gate-flows/compile/compile-flow-scope-guards';

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
