import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveReplayScope,
    resolveReviewCycleReplayScope
} from '../../../../../../src/cli/commands/gate-flows/recovery/recovery-flow-replay-scope';

describe('cli/commands/gate-flows/recovery replay scope', () => {
    it('preserves dirty-baseline task-owned scope when restarting a coherent cycle', () => {
        const previousPreflight = {
            detection_source: 'git_auto_current_workspace',
            changed_files: [
                'src/gates/task-owned.ts',
                'src/local-baseline.ts',
                'src/notes/untouched-baseline.md'
            ],
            triggers: {
                dirty_workspace_task_owned_files: ['src/gates/task-owned.ts'],
                dirty_workspace_untouched_baseline_files: [
                    'src/local-baseline.ts',
                    'src/notes/untouched-baseline.md'
                ]
            }
        };

        const replayScope = resolveReplayScope({}, previousPreflight as never);

        assert.deepEqual(replayScope.plannedChangedFiles, ['src/gates/task-owned.ts']);
        assert.deepEqual(replayScope.changedFiles, ['src/gates/task-owned.ts']);
        assert.equal(replayScope.detectionSource, 'explicit_changed_files');
    });

    it('preserves previous changed files when replay triggers omit dirty-baseline arrays', () => {
        const previousPreflight = {
            detection_source: 'git_auto_current_workspace',
            changed_files: [
                'src/gates/task-owned.ts',
                'src/local-baseline.ts'
            ],
            triggers: {
                unrelated_recovery_trigger: true
            }
        };

        const replayScope = resolveReplayScope({}, previousPreflight as never);

        assert.deepEqual(replayScope.plannedChangedFiles, [
            'src/gates/task-owned.ts',
            'src/local-baseline.ts'
        ]);
        assert.deepEqual(replayScope.changedFiles, [
            'src/gates/task-owned.ts',
            'src/local-baseline.ts'
        ]);
        assert.equal(replayScope.detectionSource, 'explicit_changed_files');
    });

    it('preserves dirty-baseline task-owned scope when restarting a review cycle', () => {
        const previousPreflight = {
            detection_source: 'git_auto_current_workspace',
            changed_files: [
                'src/gates/task-owned.ts',
                'src/local-baseline.ts',
                'src/notes/untouched-baseline.md'
            ],
            triggers: {
                dirty_workspace_task_owned_files: ['src/gates/task-owned.ts'],
                dirty_workspace_untouched_baseline_files: [
                    'src/local-baseline.ts',
                    'src/notes/untouched-baseline.md'
                ]
            }
        };
        const previousTaskMode = {
            dirty_workspace_baseline: {
                changed_files: [
                    'src/local-baseline.ts',
                    'src/notes/untouched-baseline.md'
                ]
            }
        };

        const replayScope = resolveReviewCycleReplayScope(
            {},
            previousPreflight as never,
            previousTaskMode as never
        );

        assert.deepEqual(replayScope.plannedChangedFiles, ['src/gates/task-owned.ts']);
        assert.deepEqual(replayScope.changedFiles, ['src/gates/task-owned.ts']);
        assert.equal(replayScope.detectionSource, 'explicit_changed_files');
    });
});
