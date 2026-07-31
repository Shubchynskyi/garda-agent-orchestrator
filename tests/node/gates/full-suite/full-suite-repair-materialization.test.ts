import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    materializeFullSuiteRepairTask,
    readFullSuiteRepairTaskMaterializationEvidence
} from '../../../../src/gates/full-suite/full-suite-repair-materialization';
import {
    materializeFullSuiteRepairTask as materializeFullSuiteRepairTaskFromFacade,
    readFullSuiteRepairTaskMaterializationEvidence as readMaterializationEvidenceFromFacade
} from '../../../../src/gates/full-suite/full-suite-repair-task';

describe('full-suite repair materialization compatibility', () => {
    it('preserves materialization exports through the compatibility facade', () => {
        assert.equal(materializeFullSuiteRepairTaskFromFacade, materializeFullSuiteRepairTask);
        assert.equal(readMaterializationEvidenceFromFacade, readFullSuiteRepairTaskMaterializationEvidence);
    });
});
