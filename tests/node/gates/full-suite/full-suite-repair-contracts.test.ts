import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildRestoreFullSuiteRepairWipCommand,
    formatFullSuiteRepairOutput,
    quoteCommandValue,
    resolveRepoPath,
    validateRepairChildTaskId
} from '../../../../src/gates/full-suite/full-suite-repair-contracts';
import type {
    FullSuiteRepairTaskMaterializationResult,
    FullSuiteRepairTaskProposal,
    FullSuiteRepairWipRestoreResult
} from '../../../../src/gates/full-suite';

describe('full-suite repair contracts', () => {
    it('preserves the public facade type exports', () => {
        const proposal: FullSuiteRepairTaskProposal = {
            suggested_task_id: 'T-930-1-1-F1',
            title: 'Cover facade exports',
            area: 'tests/full-suite-repair',
            rationale: 'Keep the original import path source-compatible.'
        };
        const materialization: FullSuiteRepairTaskMaterializationResult = {
            status: 'MATERIALIZED',
            task_id: 'T-930-1-1',
            child_task_id: proposal.suggested_task_id,
            artifact_path: 'runtime/reviews/repair.json',
            wip_manifest_path: 'runtime/wip/manifest.json',
            split_required_artifact_path: null,
            violations: [],
            output_lines: []
        };
        const restore: FullSuiteRepairWipRestoreResult = {
            status: 'RESTORED',
            manifest_path: materialization.wip_manifest_path ?? '',
            restored_files: [],
            violations: [],
            output_lines: []
        };

        assert.equal(restore.manifest_path, 'runtime/wip/manifest.json');
    });

    it('quotes normalized command values without changing PowerShell single-quote semantics', () => {
        assert.equal(
            quoteCommandValue(`runtime\\reviews\\O'Reilly.json`),
            `'runtime/reviews/O''Reilly.json'`
        );
    });

    it('formats the restore command with repo-relative paths byte-for-byte', (context) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-contracts-'));
        context.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
        fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '', 'utf8');

        assert.equal(
            buildRestoreFullSuiteRepairWipCommand({
                repoRoot,
                taskId: 'T-930-1-1',
                fullSuiteArtifactPath: path.join(repoRoot, 'runtime', 'reviews', `full suite's.json`),
                manifestPath: path.join(repoRoot, 'runtime', 'wip', 'manifest.json'),
                childTaskId: 'T-930-1-1-F1'
            }),
            [
                'node bin/garda.js gate restore-full-suite-repair-wip',
                `--task-id 'T-930-1-1'`,
                `--full-suite-artifact-path 'runtime/reviews/full suite''s.json'`,
                `--manifest-path 'runtime/wip/manifest.json'`,
                `--child-task-id 'T-930-1-1-F1'`,
                `--repo-root '.'`
            ].join(' ')
        );
    });

    it('preserves the operator output and implicit next-step command', () => {
        assert.deepEqual(
            formatFullSuiteRepairOutput({
                repoRoot: process.cwd(),
                taskId: 'T-930-1-1',
                status: 'MATERIALIZED',
                action: 'Continue with the repair child.',
                reason: 'Repair evidence was persisted.',
                detailsPath: 'runtime\\reviews\\repair.json',
                legacyLines: ['Status: MATERIALIZED']
            }),
            [
                'Next action:',
                '  Status: MATERIALIZED',
                '  Gate: full-suite-repair-task',
                '  Do: Continue with the repair child.',
                '  Reason: Repair evidence was persisted.',
                '  Command: node bin/garda.js next-step "T-930-1-1" --repo-root "."',
                '  DetailsPath: runtime/reviews/repair.json',
                '',
                'Status: MATERIALIZED'
            ]
        );
    });

    it('rejects paths outside the repository and invalid repair child ids', () => {
        const repoRoot = path.resolve('repo-root');
        assert.throws(
            () => resolveRepoPath(repoRoot, '../outside.json'),
            /Path escapes repo root: \.\.\/outside\.json/u
        );
        assert.deepEqual(
            validateRepairChildTaskId('T-930-1-1-F0', 'T-930-1-1'),
            {
                value: null,
                violations: [
                    'repair_task_proposal.suggested_task_id must match T-930-1-1-F<number>.'
                ]
            }
        );
    });
});
