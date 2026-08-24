import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildBaselineOnlyPreImplementationRoute
} from '../../../../src/gates/next-step/next-step-pre-implementation-routing';

const TASK_ID = 'T-1013-2-3-1-1-2';
const IMPLEMENTATION_SUMMARY =
    '[security] Complete selection, invocation, and acceptance provenance with exact single-consumption bindings';

function buildBaselineOnlyPreflight(): Record<string, unknown> {
    return {
        changed_files: [],
        zero_diff_guard: {
            zero_diff_detected: true,
            completion_requires_audited_no_op: true
        }
    };
}

describe('next-step baseline-only pre-implementation routing', () => {
    it('routes a complete-provenance implementation task before audited no-op', () => {
        const result = buildBaselineOnlyPreImplementationRoute({
            repoRoot: process.cwd(),
            taskEntry: {
                taskId: TASK_ID,
                status: 'IN_PROGRESS',
                area: 'workflow/review-output-correction-response-provenance',
                title: IMPLEMENTATION_SUMMARY,
                profile: 'strict',
                notes: 'Bind selection, invocation, and accepted response evidence.'
            },
            taskMode: {
                task_id: TASK_ID,
                task_summary: IMPLEMENTATION_SUMMARY
            },
            preflight: buildBaselineOnlyPreflight(),
            auditedNoOpPassed: false
        });

        assert.equal(result?.nextGate, 'implementation');
        assert.match(result?.reason || '', /task has implementation intent/u);
    });

    it('preserves explicit audit-only metadata as a no-op candidate', () => {
        const result = buildBaselineOnlyPreImplementationRoute({
            repoRoot: process.cwd(),
            taskEntry: {
                taskId: TASK_ID,
                status: 'IN_PROGRESS',
                area: 'workflow/audit-only',
                title: 'Audit-only: validate current closeout evidence',
                profile: 'strict',
                notes: null
            },
            taskMode: {
                task_id: TASK_ID,
                task_summary: 'Audit-only: validate current closeout evidence'
            },
            preflight: buildBaselineOnlyPreflight(),
            auditedNoOpPassed: false
        });

        assert.equal(result, null);
    });
});
