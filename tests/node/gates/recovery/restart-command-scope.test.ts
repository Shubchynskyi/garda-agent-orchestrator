import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    resolveRestartCommandChangedFiles
} from '../../../../src/gates/recovery/restart-command-scope';
import {
    normalizeRuleFileList
} from '../../../../src/cli/commands/gate-flows/recovery/recovery-flow-replay-scope';

function writePreflight(repoRoot: string, fileName: string, payload: Record<string, unknown>): string {
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', fileName);
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return preflightPath;
}

describe('gates/recovery restart-command-scope', () => {
    it('uses compact TASK_ENTRY base rules for depth 1 recovery replay scopes', () => {
        assert.deepEqual(normalizeRuleFileList({}, 1), [
            '00-core.md',
            '40-commands.md',
            '80-task-workflow.md'
        ]);
    });

    it('keeps full TASK_ENTRY base rules for depth 3 recovery replay scopes', () => {
        assert.deepEqual(normalizeRuleFileList({}, 3), [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]);
    });

    it('preserves mixed source and materialized workflow-config scope', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-command-scope-'));
        try {
            const preflightPath = writePreflight(repoRoot, 'T-936-preflight.json', {
                changed_files: ['src/app.ts'],
                triggers: {
                    changed_workflow_config_files: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                    workflow_config_file_hashes: {
                        'garda-agent-orchestrator/live/config/workflow-config.json': 'c'.repeat(64)
                    }
                }
            });

            assert.deepEqual(resolveRestartCommandChangedFiles(repoRoot, preflightPath), [
                'garda-agent-orchestrator/live/config/workflow-config.json',
                'src/app.ts'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves source-checkout live and template workflow-config paths', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-source-config-'));
        try {
            const preflightPath = writePreflight(repoRoot, 'T-936-source-preflight.json', {
                changed_files: ['live/config/workflow-config.json'],
                triggers: {
                    changed_workflow_config_files: ['template/config/workflow-config.json'],
                    workflow_config_file_hashes: {
                        'template/config/workflow-config.json': 'd'.repeat(64)
                    }
                }
            });

            assert.deepEqual(resolveRestartCommandChangedFiles(repoRoot, preflightPath), [
                'live/config/workflow-config.json',
                'template/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('uses preflight evidence for ignored workflow-config paths without consulting git auto scope', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-ignored-config-'));
        try {
            fs.writeFileSync(
                path.join(repoRoot, '.gitignore'),
                'garda-agent-orchestrator/live/config/workflow-config.json\n',
                'utf8'
            );
            const preflightPath = writePreflight(repoRoot, 'T-936-ignored-preflight.json', {
                changed_files: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                triggers: {
                    changed_workflow_config_files: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                    workflow_config_file_hashes: {
                        'garda-agent-orchestrator/live/config/workflow-config.json': 'e'.repeat(64)
                    }
                }
            });

            assert.deepEqual(resolveRestartCommandChangedFiles(repoRoot, preflightPath), [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails closed when workflow-config trigger paths lack hash attribution', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-unaudited-config-'));
        try {
            const preflightPath = writePreflight(repoRoot, 'T-936-unaudited-preflight.json', {
                changed_files: ['src/app.ts'],
                triggers: {
                    changed_workflow_config_files: ['garda-agent-orchestrator/live/config/workflow-config.json']
                }
            });

            assert.deepEqual(resolveRestartCommandChangedFiles(repoRoot, preflightPath), []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
