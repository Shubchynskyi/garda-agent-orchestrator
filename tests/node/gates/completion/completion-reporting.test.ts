import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCompletionGateSuccessAfterCommand,
    buildReviewCycleRestartCommand,
    formatCompletionGateResult
} from '../../../../src/gates/completion/completion-reporting';

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

    it('renders completion pass guidance back to next-step and final closeout', () => {
        const output = formatCompletionGateResult({
            status: 'PASSED',
            outcome: 'PASS',
            task_id: 'T-645',
            repo_root: process.cwd()
        });

        assert.match(output, /COMPLETION_GATE_PASSED/);
        assert.match(output, /AfterCommand: rerun node bin\/garda\.js next-step "T-645" --repo-root "\."/);
        assert.doesNotMatch(output, /task-audit-summary command/);
        assert.match(output, /mandatory final report/);
        assert.match(output, /asking for commit permission/);
    });

    it('does not render final-closeout success guidance for failed completion gate output', () => {
        const output = formatCompletionGateResult({
            status: 'FAILED',
            outcome: 'FAIL',
            task_id: 'T-645',
            repo_root: process.cwd(),
            violations: ['review gate missing']
        });

        assert.match(output, /COMPLETION_GATE_FAILED/);
        assert.doesNotMatch(output, /AfterCommand: rerun/);
        assert.doesNotMatch(output, /mandatory final report/);
    });

    it('builds the completion success after-command with the source checkout navigator', () => {
        const command = buildCompletionGateSuccessAfterCommand(process.cwd(), 'T-645');

        assert.match(command, /^AfterCommand: rerun node bin\/garda\.js next-step "T-645" --repo-root "\."/);
        assert.doesNotMatch(command, /task-audit-summary/);
        assert.match(command, /mandatory final report/);
    });
});
