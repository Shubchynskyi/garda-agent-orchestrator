import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildOrchestratorWorkRestartCommand
} from '../../../../src/gates/next-step/next-step-lifecycle-command-builders';

describe('gates/next-step lifecycle command builders', () => {
    it('omits workflow-config planned files from protected task-mode restart commands without workflow-config authorization', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-mode-restart-omit-config-'));
        try {
            const command = buildOrchestratorWorkRestartCommand(
                repoRoot,
                'node bin/garda.js',
                'T-123',
                {
                    task_id: 'T-123',
                    entry_mode: 'EXPLICIT_TASK_EXECUTION',
                    requested_depth: 2,
                    task_summary: 'Repair protected restart scope',
                    provider: 'Codex',
                    planned_changed_files: [
                        'src/app.ts',
                        'garda-agent-orchestrator/live/config/workflow-config.json'
                    ]
                },
                [],
                false
            );

            assert.ok(command.includes('--orchestrator-work'), command);
            assert.ok(command.includes('--upgrade-existing-task-mode'), command);
            assert.ok(!command.includes('--workflow-config-work'), command);
            assert.ok(command.includes('--planned-changed-file "src/app.ts"'), command);
            assert.ok(!command.includes('garda-agent-orchestrator/live/config/workflow-config.json'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves workflow-config planned files from protected task-mode restart commands with workflow-config authorization', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-task-mode-restart-keep-config-'));
        try {
            const command = buildOrchestratorWorkRestartCommand(
                repoRoot,
                'node bin/garda.js',
                'T-123',
                {
                    task_id: 'T-123',
                    entry_mode: 'EXPLICIT_TASK_EXECUTION',
                    requested_depth: 2,
                    task_summary: 'Repair protected restart scope',
                    provider: 'Codex',
                    planned_changed_files: [
                        'src/app.ts',
                        'garda-agent-orchestrator/live/config/workflow-config.json'
                    ]
                },
                [],
                true
            );

            assert.ok(command.includes('--orchestrator-work'), command);
            assert.ok(command.includes('--workflow-config-work'), command);
            assert.ok(command.includes('--upgrade-existing-task-mode'), command);
            assert.ok(command.includes('--planned-changed-file "src/app.ts"'), command);
            assert.ok(command.includes('--planned-changed-file "garda-agent-orchestrator/live/config/workflow-config.json"'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
