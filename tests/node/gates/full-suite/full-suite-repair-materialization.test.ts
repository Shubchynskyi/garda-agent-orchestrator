import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    materializeFullSuiteRepairTask,
    readFullSuiteRepairTaskMaterializationEvidence
} from '../../../../src/gates/full-suite/full-suite-repair-materialization';
import {
    isRepairQualifiedFullSuiteArtifact
} from '../../../../src/gates/full-suite/full-suite-repair-decomposition';
import {
    materializeFullSuiteRepairTask as materializeFullSuiteRepairTaskFromFacade,
    readFullSuiteRepairTaskMaterializationEvidence as readMaterializationEvidenceFromFacade
} from '../../../../src/gates/full-suite/full-suite-repair-task';

describe('full-suite repair materialization compatibility', () => {
    it('preserves materialization exports through the compatibility facade', () => {
        assert.equal(materializeFullSuiteRepairTaskFromFacade, materializeFullSuiteRepairTask);
        assert.equal(readMaterializationEvidenceFromFacade, readFullSuiteRepairTaskMaterializationEvidence);
    });

    it('accepts generated timeout artifacts bound through cycle_binding', () => {
        const artifact = {
            timed_out: true,
            cycle_binding: { task_id: 'T-BOUND' },
            timeout_policy: {
                timeout_blocker: true,
                attempts_exhausted: true,
                repair_task_proposal: { suggested_task_id: 'T-BOUND-F1' }
            }
        };

        assert.equal(isRepairQualifiedFullSuiteArtifact(artifact, 'T-BOUND'), true);
    });

    it('rejects conflicting top-level and cycle-bound task identities', () => {
        const artifact = {
            task_id: 'T-BOUND',
            timed_out: true,
            cycle_binding: { task_id: 'T-FOREIGN' },
            timeout_policy: {
                timeout_blocker: true,
                attempts_exhausted: true,
                repair_task_proposal: { suggested_task_id: 'T-BOUND-F1' }
            }
        };

        assert.equal(isRepairQualifiedFullSuiteArtifact(artifact, 'T-BOUND'), false);
    });
});
