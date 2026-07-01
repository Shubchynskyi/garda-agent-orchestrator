import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildRestartReviewCycleCommand
} from '../../../../src/gates/next-step/next-step-review-command-builders';

describe('gates/next-step review command builders', () => {
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
