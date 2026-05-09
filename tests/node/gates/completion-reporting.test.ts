import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewCycleRestartCommand } from '../../../src/gates/completion-reporting';

describe('gates/completion-reporting', () => {
    it('renders review-cycle restart guidance with a non-valid impact-analysis placeholder', () => {
        const command = buildReviewCycleRestartCommand(
            'D:/repo',
            'T-123',
            'garda-agent-orchestrator/runtime/reviews/T-123-preflight.json',
            null,
            null,
            null
        );

        assert.match(command, /gate restart-review-cycle/);
        assert.match(command, /--impact-analysis/);
        assert.match(command, /<replace with main-agent remediation impact analysis>/);
        assert.doesNotMatch(command, /reviewer finding; intended fix; affected files\/contracts/);
    });
});
