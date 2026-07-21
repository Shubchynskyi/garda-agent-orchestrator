import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getTaskModeEvidence } from '../../../../../../src/gates/task-mode';
import {
    createTempRepo,
    initializeGitRepo,
    runEnterTaskMode,
    seedInitAnswers
} from '../../gate-test-helpers';

function seedUpgradeTask(repoRoot: string, taskId: string): void {
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), [
        'TASK.md',
        'garda-agent-orchestrator/runtime/'
    ].join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | TODO | P1 | workflow | Upgrade workflow-config policy changes | unassigned | 2026-07-21 | default | Owns workflow-config policy changes. |`
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# baseline\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    }, null, 2) + '\n', 'utf8');
    seedInitAnswers(repoRoot);
    initializeGitRepo(repoRoot);
}

describe('task-mode scope upgrade', () => {
    it('preserves the original baseline and workflow hashes while authorizing post-entry protected changes', {
        concurrency: false
    }, () => {
        const taskId = 'T-900scope-upgrade';
        const repoRoot = createTempRepo();
        const configPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'config',
            'workflow-config.json'
        );

        try {
            seedUpgradeTask(repoRoot, taskId);
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Implement protected workflow changes'
            });
            const originalEvidence = getTaskModeEvidence(repoRoot, taskId);
            assert.equal(originalEvidence.evidence_status, 'PASS');
            assert.deepEqual(originalEvidence.dirty_workspace_baseline?.changed_files, []);
            assert.ok(originalEvidence.workflow_config_file_hashes);

            fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const upgraded = true;\n', 'utf8');
            fs.appendFileSync(configPath, '\n', 'utf8');

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    orchestratorWork: true,
                    workflowConfigWork: true,
                    operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(),
                    plannedChangedFiles: [
                        'src/app.ts',
                        'garda-agent-orchestrator/live/config/workflow-config.json'
                    ],
                    taskSummary: 'Implement protected workflow changes'
                }),
                /already contains workflow config changes before task-mode entry/
            );

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                orchestratorWork: true,
                workflowConfigWork: true,
                upgradeExistingTaskMode: true,
                operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString(),
                plannedChangedFiles: [
                    'src/app.ts',
                    'garda-agent-orchestrator/live/config/workflow-config.json'
                ],
                taskSummary: 'Implement protected workflow changes'
            });
            assert.equal(result.exitCode, 0);

            const upgradedEvidence = getTaskModeEvidence(repoRoot, taskId);
            assert.equal(upgradedEvidence.orchestrator_work, true);
            assert.equal(upgradedEvidence.workflow_config_work, true);
            assert.deepEqual(upgradedEvidence.dirty_workspace_baseline, originalEvidence.dirty_workspace_baseline);
            assert.deepEqual(upgradedEvidence.workflow_config_file_hashes, originalEvidence.workflow_config_file_hashes);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects an upgrade without previous evidence and an incomplete post-entry scope', {
        concurrency: false
    }, () => {
        const missingEvidenceTaskId = 'T-900scope-upgrade-missing';
        const repoRoot = createTempRepo();

        try {
            seedUpgradeTask(repoRoot, missingEvidenceTaskId);
            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId: missingEvidenceTaskId,
                    orchestratorWork: true,
                    upgradeExistingTaskMode: true,
                    operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(),
                    plannedChangedFiles: ['src/app.ts'],
                    taskSummary: 'Implement protected workflow changes'
                }),
                /without valid current task-mode evidence/
            );

            runEnterTaskMode({
                repoRoot,
                taskId: missingEvidenceTaskId,
                taskSummary: 'Implement protected workflow changes'
            });
            fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changed = true;\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'src', 'extra.ts'), 'export const extra = true;\n', 'utf8');

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId: missingEvidenceTaskId,
                    orchestratorWork: true,
                    upgradeExistingTaskMode: true,
                    operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(),
                    plannedChangedFiles: ['src/app.ts'],
                    taskSummary: 'Implement protected workflow changes'
                }),
                /requires every post-entry changed file in the planned scope: src\/extra\.ts/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
