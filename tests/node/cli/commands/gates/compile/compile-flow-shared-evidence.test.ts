import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildClassifyChangeOrchestratorWorkRestartCommand } from '../../../../../../src/cli/commands/gate-flows/compile/compile-flow-shared-evidence';
import type { TaskModeEvidenceResult } from '../../../../../../src/gates/task-mode/task-mode-contracts';

function createTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-compile-shared-'));
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2), 'utf8');
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.writeFileSync(
        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
        JSON.stringify({}, null, 2),
        'utf8'
    );
    return repoRoot;
}

function baseTaskModeEvidence(overrides: Partial<TaskModeEvidenceResult> = {}): TaskModeEvidenceResult {
    return {
        task_id: 'T-restart-depth',
        entry_mode: 'EXPLICIT_TASK_EXECUTION',
        requested_depth: 3,
        effective_depth: 3,
        requested_depth_source: 'profile_default',
        effective_depth_source: 'requested_depth',
        task_summary: 'Preserve restart depth snapshot',
        planned_changed_files: ['src/gates/next-step/next-step.ts'],
        workflow_config_work: false,
        start_banner: null,
        provider: 'Codex',
        routed_to: 'AGENTS.md',
        ...overrides
    } as TaskModeEvidenceResult;
}

describe('compile-flow shared restart evidence', () => {
    it('preserves profile-default task-mode depth in protected restart commands', () => {
        const repoRoot = createTempRepo();
        try {
            const command = buildClassifyChangeOrchestratorWorkRestartCommand({
                repoRoot,
                taskId: 'T-restart-depth',
                taskModeEvidence: baseTaskModeEvidence(),
                taskSummary: 'Preserve restart depth snapshot',
                changedFiles: ['src/cli/main.ts']
            });

            assert.match(command, /gate enter-task-mode/);
            assert.ok(command.includes('--orchestrator-work'));
            assert.ok(command.includes('--requested-depth "3"'));
            assert.ok(!command.includes('--effective-depth'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves legacy effective-depth overrides in protected restart commands', () => {
        const repoRoot = createTempRepo();
        try {
            const command = buildClassifyChangeOrchestratorWorkRestartCommand({
                repoRoot,
                taskId: 'T-restart-depth',
                taskModeEvidence: baseTaskModeEvidence({
                    requested_depth: 2,
                    effective_depth: 3,
                    requested_depth_source: null,
                    effective_depth_source: null
                }),
                taskSummary: 'Preserve legacy restart depth override',
                changedFiles: ['src/cli/main.ts']
            });

            assert.ok(command.includes('--requested-depth "2"'));
            assert.ok(command.includes('--effective-depth "3"'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
