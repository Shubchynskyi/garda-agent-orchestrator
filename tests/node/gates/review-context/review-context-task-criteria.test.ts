import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildTaskCriteria,
    buildTaskCriteriaMarkdown
} from '../../../../src/gates/review-context/review-context-task-criteria';

describe('gates/review-context task criteria', () => {
    it('exposes dirty-baseline task-owned scope and excluded untouched baseline to reviewers', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-task-criteria-'));
        try {
            const criteria = buildTaskCriteria({
                repoRoot,
                taskId: 'T-966-4',
                preflight: {
                    task_intent: 'Keep recovery and commit scope task-owned',
                    changed_files: [
                        'src/gates/task-owned.ts',
                        'src/local-baseline.ts'
                    ],
                    triggers: {
                        dirty_workspace_task_owned_files: ['src/gates/task-owned.ts'],
                        dirty_workspace_untouched_baseline_files: ['src/local-baseline.ts']
                    }
                },
                taskModeEvidence: null
            });
            const typedCriteria = criteria as unknown as {
                task_scope?: {
                    changed_files: string[];
                    task_owned_files: string[];
                    excluded_untouched_baseline_files: string[];
                };
            };

            assert.deepEqual(typedCriteria.task_scope?.changed_files, ['src/gates/task-owned.ts']);
            assert.deepEqual(typedCriteria.task_scope?.task_owned_files, ['src/gates/task-owned.ts']);
            assert.deepEqual(typedCriteria.task_scope?.excluded_untouched_baseline_files, ['src/local-baseline.ts']);

            const markdown = buildTaskCriteriaMarkdown(criteria).join('\n');
            assert.match(markdown, /Task-owned changed files/u);
            assert.match(markdown, /src\/gates\/task-owned\.ts/u);
            assert.match(markdown, /Untouched dirty-baseline files excluded from task scope/u);
            assert.match(markdown, /src\/local-baseline\.ts/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
