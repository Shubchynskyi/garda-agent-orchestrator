import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildRestartReviewCycleCommand
} from '../../../../src/gates/next-step/next-step-review-command-builders';

describe('gates/next-step review command builders', () => {
    it('carries source-checkout workflow-config scope in restart-review-cycle commands', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-command-scope-'));
        try {
            const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-SCOPE-preflight.json');
            fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                changed_files: ['src/app.ts', 'live/config/workflow-config.json'],
                triggers: {
                    changed_workflow_config_files: ['template/config/workflow-config.json'],
                    workflow_config_file_hashes: {
                        'template/config/workflow-config.json': 'b'.repeat(64)
                    }
                }
            }, null, 2) + '\n', 'utf8');

            const command = buildRestartReviewCycleCommand(
                repoRoot,
                'node bin/garda.js',
                'T-SCOPE',
                'Repair failed review routing',
                'garda-agent-orchestrator/runtime/reviews/T-SCOPE-preflight.json',
                null
            );

            assert.ok(command.includes('--changed-file "live/config/workflow-config.json"'), command);
            assert.ok(command.includes('--changed-file "template/config/workflow-config.json"'), command);
            assert.ok(command.includes('--changed-file "src/app.ts"'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('binds restart-review-cycle commands to the active preflight path', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-restart-command-'));
        try {
            const command = buildRestartReviewCycleCommand(
                repoRoot,
                'node bin/garda.js',
                'T-CUSTOM',
                'Repair failed review routing',
                'garda-agent-orchestrator/runtime/custom reviews/T-CUSTOM-preflight.json',
                null
            );

            assert.ok(command.includes('gate restart-review-cycle'), command);
            assert.ok(
                command.includes('--preflight-path "garda-agent-orchestrator/runtime/custom reviews/T-CUSTOM-preflight.json"'),
                command
            );
            assert.ok(!command.includes('runtime/reviews/T-CUSTOM-preflight.json'), command);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
